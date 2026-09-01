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
}

type routeState interface {
	Close() error
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
	rt.tunnel.SetUDPTimeout(90 * time.Second)
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

func (r *vpnRuntime) healthLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			err := r.proxy.Probe(probeCtx)
			cancel()
			if err != nil {
				r.setError(err)
			} else {
				r.setError(nil)
			}
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
