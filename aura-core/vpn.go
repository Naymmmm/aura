package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	t2core "github.com/xjasonlyu/tun2socks/v2/core"
	"github.com/xjasonlyu/tun2socks/v2/core/device"
	"github.com/xjasonlyu/tun2socks/v2/core/device/tun"
	"github.com/xjasonlyu/tun2socks/v2/core/option"
	t2log "github.com/xjasonlyu/tun2socks/v2/log"
	"github.com/xjasonlyu/tun2socks/v2/tunnel"
	"github.com/xjasonlyu/tun2socks/v2/tunnel/statistic"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

type runtimeStats struct {
	Running       bool           `json:"running"`
	ActiveServer  string         `json:"active_server,omitempty"`
	Latencies     map[string]int `json:"latencies"`
	UploadTotal   int64          `json:"upload_total"`
	DownloadTotal int64          `json:"download_total"`
	LastError     string         `json:"last_error,omitempty"`
	// Tailscale: "" (not running), "ok" (coexisting) or "rerouted" (Aura
	// pointed a hijacked 100.64/10 route back at Tailscale).
	Tailscale string `json:"tailscale,omitempty"`
}

type routeState interface {
	Close() error
	TailscaleState() string
}

type vpnRuntime struct {
	startedAt time.Time
	naive     *managedProcess
	proxy     *multiProxy
	manager   *statistic.Manager
	device    device.Device
	stack     *stack.Stack
	tunnel    *tunnel.Tunnel
	routes    routeState
	cancel    context.CancelFunc
	closed    atomic.Bool
	stopOnce  sync.Once
	stopErr   error
	errMu     sync.Mutex
	lastError string
}

func init() {
	// tun2socks logs every TCP/UDP flow at info level; on a busy machine that
	// is thousands of synchronous writes a minute into a log nobody rotates.
	if logger, err := t2log.NewLeveled(t2log.WarnLevel); err == nil {
		t2log.SetLogger(logger)
	}
}

func startVPN(stateDir, naivePath string, cfg auraConfig) (_ *vpnRuntime, err error) {
	cfg.Servers, err = pinServerIPv4(cfg.Servers)
	if err != nil {
		return nil, err
	}
	process, endpoints, err := startNaive(stateDir, naivePath, cfg.Servers)
	if err != nil {
		return nil, fmt.Errorf("start NaiveProxy: %w", err)
	}
	rt := &vpnRuntime{startedAt: time.Now(), naive: process}
	defer func() {
		if err != nil {
			_ = rt.Stop()
		}
	}()

	rt.proxy = newMultiProxy(endpoints)
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = rt.proxy.Probe(probeCtx)
	probeCancel()
	if err != nil {
		return nil, err
	}

	rt.manager = statistic.DefaultManager
	rt.manager.ResetStatistic()
	rt.tunnel = tunnel.New(rt.proxy, rt.manager)
	// Idle UDP flows (QUIC, DNS) each hold a goroutine and a UoT stream.
	rt.tunnel.SetUDPTimeout(60 * time.Second)
	rt.tunnel.ProcessAsync()
	rt.device, err = tun.Open(tunDeviceName(), uint32(cfg.TUN.MTU))
	if err != nil {
		return nil, fmt.Errorf("open TUN: %w", err)
	}
	rt.stack, err = t2core.CreateStack(&t2core.Config{
		LinkEndpoint:     rt.device,
		TransportHandler: rt.tunnel,
		Options: []option.Option{
			option.WithTCPModerateReceiveBuffer(true),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create TUN netstack: %w", err)
	}
	rt.routes, err = configureRoutes(rt.device.Name(), cfg)
	if err != nil {
		return nil, fmt.Errorf("configure system routes: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	rt.cancel = cancel
	go rt.healthLoop(ctx)
	go rt.watchNaive()
	return rt, nil
}

// healthLoop keeps an eye on the tunnel as cheaply as possible: real traffic
// is proof of life, an idle tunnel gets a SOCKS-only check once a minute, and
// the full TLS probe (which also picks the fastest server) only runs when that
// check fails.
func (r *vpnRuntime) healthLoop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	var lastTotal int64
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			snapshot := r.manager.Snapshot()
			total := snapshot.UploadTotal + snapshot.DownloadTotal
			if total != lastTotal {
				lastTotal = total
				r.setError(nil)
				continue
			}
			checkCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			err := r.proxy.CheckActive(checkCtx)
			if err != nil {
				err = r.proxy.Probe(checkCtx)
			}
			cancel()
			r.setError(err)
		}
	}
}

func (r *vpnRuntime) watchNaive() {
	<-r.naive.done
	if !r.closed.Load() {
		err := r.naive.Err()
		if err == nil {
			err = errors.New("NaiveProxy exited unexpectedly")
		}
		r.setError(err)
		_ = r.Stop()
	}
}

func (r *vpnRuntime) Stop() error {
	r.stopOnce.Do(func() {
		r.closed.Store(true)
		if r.cancel != nil {
			r.cancel()
		}
		var errs []error
		if r.routes != nil {
			errs = append(errs, r.routes.Close())
		}
		if r.device != nil {
			r.device.Close()
		}
		if r.stack != nil {
			r.stack.Close()
			r.stack.Wait()
		}
		if r.tunnel != nil {
			r.tunnel.Close()
		}
		if r.naive != nil {
			errs = append(errs, r.naive.Stop())
		}
		r.stopErr = errors.Join(errs...)
	})
	return r.stopErr
}

func (r *vpnRuntime) Running() bool {
	return r != nil && !r.closed.Load() && r.naive != nil && r.naive.Running()
}

func (r *vpnRuntime) PID() int {
	if r == nil || r.naive == nil {
		return 0
	}
	return r.naive.PID()
}

func (r *vpnRuntime) Stats() runtimeStats {
	active, latencies := r.proxy.Snapshot()
	snapshot := r.manager.Snapshot()
	return runtimeStats{
		Running:       r.Running(),
		ActiveServer:  active,
		Latencies:     latencies,
		UploadTotal:   snapshot.UploadTotal,
		DownloadTotal: snapshot.DownloadTotal,
		LastError:     r.LastError(),
		Tailscale:     r.routes.TailscaleState(),
	}
}

func (r *vpnRuntime) setError(err error) {
	r.errMu.Lock()
	defer r.errMu.Unlock()
	if err == nil {
		r.lastError = ""
	} else {
		r.lastError = err.Error()
	}
}

func (r *vpnRuntime) LastError() string {
	r.errMu.Lock()
	defer r.errMu.Unlock()
	return r.lastError
}
