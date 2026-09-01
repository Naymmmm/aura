package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type managedProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	mu   sync.Mutex
	err  error
}

type naiveFileConfig struct {
	Listen            []string `json:"listen"`
	Proxy             []string `json:"proxy"`
	HostResolverRules string   `json:"host-resolver-rules,omitempty"`
	Log               string   `json:"log"`
}

func startNaive(stateDir, executable string, servers []serverConfig) (*managedProcess, []proxyEndpoint, error) {
	if info, err := os.Stat(executable); err != nil || info.IsDir() {
		return nil, nil, fmt.Errorf("NaiveProxy executable is missing: %s", executable)
	}
	ports, err := reservePorts(len(servers))
	if err != nil {
		return nil, nil, err
	}
	config := naiveFileConfig{
		Listen: make([]string, 0, len(servers)),
		Proxy:  make([]string, 0, len(servers)),
		Log:    filepath.Join(stateDir, "naive.log"),
	}
	endpoints := make([]proxyEndpoint, 0, len(servers))
	var resolverRules []string
	for i, server := range servers {
		address := net.JoinHostPort("127.0.0.1", fmt.Sprint(ports[i]))
		config.Listen = append(config.Listen, "socks://"+address)
		proxyURL := &url.URL{
			Scheme: "https",
			User:   url.UserPassword(server.Username, server.Password),
			Host:   net.JoinHostPort(server.Host, fmt.Sprint(server.Port)),
		}
		config.Proxy = append(config.Proxy, proxyURL.String())
		endpoints = append(endpoints, proxyEndpoint{tag: server.Tag, addr: address})
		if server.ConnectAddress != server.Host {
			resolverRules = append(resolverRules, "MAP "+server.Host+" "+server.ConnectAddress)
		}
	}
	config.HostResolverRules = strings.Join(resolverRules, ", ")
	configPath := filepath.Join(stateDir, "naive.json")
	raw, err := json.Marshal(config)
	if err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		return nil, nil, err
	}
	coreLog, err := os.OpenFile(filepath.Join(stateDir, "core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.Command(executable, configPath)
	cmd.Dir = stateDir
	cmd.Stdout, cmd.Stderr = coreLog, coreLog
	configureChild(cmd)
	if err := cmd.Start(); err != nil {
		_ = coreLog.Close()
		return nil, nil, err
	}
	process := &managedProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		_ = coreLog.Close()
		process.mu.Lock()
		process.err = err
		process.mu.Unlock()
		close(process.done)
	}()
	deadline := time.Now().Add(8 * time.Second)
	for _, endpoint := range endpoints {
		for {
			conn, dialErr := net.DialTimeout("tcp", endpoint.addr, 150*time.Millisecond)
			if dialErr == nil {
				_ = conn.Close()
				break
			}
			select {
			case <-process.done:
				return nil, nil, fmt.Errorf("NaiveProxy exited during startup: %w", process.Err())
			default:
			}
			if time.Now().After(deadline) {
				_ = process.Stop()
				return nil, nil, errors.New("NaiveProxy did not open its local SOCKS listeners")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return process, endpoints, nil
}

func reservePorts(count int) ([]int, error) {
	listeners := make([]net.Listener, 0, count)
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	ports := make([]int, 0, count)
	for range count {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		listeners = append(listeners, listener)
		ports = append(ports, listener.Addr().(*net.TCPAddr).Port)
	}
	return ports, nil
}

func (p *managedProcess) PID() int {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *managedProcess) Err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (p *managedProcess) Running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *managedProcess) Stop() error {
	select {
	case <-p.done:
		return nil
	default:
	}
	if p.cmd != nil && p.cmd.Process != nil {
		if err := terminateChild(p.cmd); err != nil && !errors.Is(err, os.ErrProcessDone) {
			select {
			case <-p.done:
				return nil
			default:
				return err
			}
		}
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(5 * time.Second):
		if p.cmd != nil && p.cmd.Process != nil {
			return p.cmd.Process.Kill()
		}
		return nil
	}
}
