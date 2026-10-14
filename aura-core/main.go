package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	version       = "26.3.0"
	defaultListen = "127.0.0.1:45873"
)

type core struct {
	mu        sync.Mutex
	stateDir  string
	naivePath string
	runtime   *vpnRuntime
	lastError string
}

type status struct {
	Version   string `json:"version"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	StartedAt string `json:"started_at,omitempty"`
	LastError string `json:"last_error,omitempty"`
}

type startRequest struct {
	Config json.RawMessage `json:"config"`
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: aura-core serve [options]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", defaultListen, "loopback API address")
	stateDir := fs.String("state-dir", "", "Aura Core state directory")
	tokenFile := fs.String("token-file", "", "file containing API bearer token")
	naivePath := fs.String("naive", "", "NaiveProxy executable")
	_ = fs.Parse(os.Args[2:])

	if *stateDir == "" || *tokenFile == "" {
		log.Fatal("--state-dir and --token-file are required")
	}
	if err := os.MkdirAll(*stateDir, 0700); err != nil {
		log.Fatal(err)
	}
	helperLog, err := os.OpenFile(filepath.Join(*stateDir, "helper.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer helperLog.Close()
	log.SetOutput(helperLog)
	tokenBytes, err := os.ReadFile(*tokenFile)
	if err != nil || strings.TrimSpace(string(tokenBytes)) == "" {
		log.Fatalf("read token: %v", err)
	}
	token := strings.TrimSpace(string(tokenBytes))
	if *naivePath == "" {
		name := "naive"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		*naivePath = filepath.Join(filepath.Dir(mustExecutable()), name)
	}

	// The helper runs all day in the background: keep the Go heap small. This is
	// a soft limit — the GC works harder near it instead of growing the heap.
	debug.SetMemoryLimit(48 << 20)

	c := &core{stateDir: *stateDir, naivePath: *naivePath}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", c.statusHandler)
	mux.HandleFunc("GET /v1/stats", c.statsHandler)
	mux.HandleFunc("POST /v1/start", c.startHandler)
	mux.HandleFunc("POST /v1/stop", c.stopHandler)
	mux.HandleFunc("GET /v1/log", c.logHandler)
	server := &http.Server{
		Addr:              *listen,
		Handler:           authenticate(token, mux),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       8 * time.Second,
		WriteTimeout:      8 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("aura-core %s listening on %s", version, *listen)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		shutdownCtx, done := context.WithTimeout(context.Background(), 8*time.Second)
		defer done()
		_ = server.Shutdown(shutdownCtx)
		_ = c.stop()
	}()
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func authenticate(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(got) != len(token) || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (c *core) snapshot() status {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := status{Version: version, LastError: c.lastError}
	if c.runtime != nil {
		s.Running = c.runtime.Running()
		s.PID = c.runtime.PID()
		s.StartedAt = c.runtime.startedAt.UTC().Format(time.RFC3339)
		if errText := c.runtime.LastError(); errText != "" {
			s.LastError = errText
		}
	}
	return s
}

func (c *core) statusHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, c.snapshot())
}

func (c *core) statsHandler(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	rt := c.runtime
	lastError := c.lastError
	c.mu.Unlock()
	if rt == nil {
		writeJSON(w, http.StatusOK, runtimeStats{LastError: lastError})
		return
	}
	stats := rt.Stats()
	if stats.LastError == "" {
		stats.LastError = lastError
	}
	writeJSON(w, http.StatusOK, stats)
}

func (c *core) startHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	var request startRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid start request"})
		return
	}
	cfg, err := parseConfig(request.Config)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	configPath := filepath.Join(c.stateDir, "config.json")
	if err := os.WriteFile(configPath, request.Config, 0600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := c.start(cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c.snapshot())
}

func (c *core) start(cfg auraConfig) error {
	if err := c.stop(); err != nil {
		return fmt.Errorf("stop previous tunnel: %w", err)
	}
	rt, err := startVPN(c.stateDir, c.naivePath, cfg)
	if err != nil {
		c.mu.Lock()
		c.lastError = err.Error()
		c.mu.Unlock()
		return err
	}
	c.mu.Lock()
	c.runtime = rt
	c.lastError = ""
	c.mu.Unlock()
	return nil
}

func (c *core) stopHandler(w http.ResponseWriter, _ *http.Request) {
	if err := c.stop(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c.snapshot())
}

func (c *core) stop() error {
	c.mu.Lock()
	rt := c.runtime
	c.runtime = nil
	c.mu.Unlock()
	if rt == nil {
		return nil
	}
	if err := rt.Stop(); err != nil {
		c.mu.Lock()
		c.lastError = err.Error()
		c.mu.Unlock()
		return err
	}
	return nil
}

func (c *core) logHandler(w http.ResponseWriter, _ *http.Request) {
	var b []byte
	for _, name := range []string{"helper.log", "core.log", "naive.log"} {
		part, err := os.ReadFile(filepath.Join(c.stateDir, name))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if len(part) > 0 {
			b = append(b, []byte("\n--- "+name+" ---\n")...)
			b = append(b, part...)
		}
	}
	const max = 32 * 1024
	if len(b) > max {
		b = b[len(b)-max:]
	}
	writeJSON(w, http.StatusOK, map[string]string{"log": string(b)})
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func mustExecutable() string {
	p, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return p
}
