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
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	version       = "0.2.6"
	defaultListen = "127.0.0.1:45873"
)

type core struct {
	mu        sync.Mutex
	stateDir  string
	engine    string
	cmd       *exec.Cmd
	startedAt time.Time
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
		fmt.Fprintf(os.Stderr, "usage: aura-core serve [options]\n")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", defaultListen, "loopback API address")
	stateDir := fs.String("state-dir", "", "Aura core state directory")
	tokenFile := fs.String("token-file", "", "file containing API bearer token")
	engine := fs.String("engine", "", "Naive/UoT engine executable")
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
	if *engine == "" {
		name := "sing-box"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		*engine = filepath.Join(filepath.Dir(mustExecutable()), "engine", name)
	}

	c := &core{stateDir: *stateDir, engine: *engine}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", c.statusHandler)
	mux.HandleFunc("POST /v1/start", c.startHandler)
	mux.HandleFunc("POST /v1/stop", c.stopHandler)
	mux.HandleFunc("GET /v1/log", c.logHandler)
	server := &http.Server{
		Addr:              *listen,
		Handler:           authenticate(token, mux),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
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
		shutdownCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
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
	if c.cmd != nil && c.cmd.Process != nil {
		s.Running = true
		s.PID = c.cmd.Process.Pid
		s.StartedAt = c.startedAt.UTC().Format(time.RFC3339)
	}
	return s
}

func (c *core) statusHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, c.snapshot())
}

func (c *core) startHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	var request startRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid start request"})
		return
	}
	if err := validateConfig(request.Config); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	config := filepath.Join(c.stateDir, "config.json")
	if err := os.WriteFile(config, request.Config, 0600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := c.start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c.snapshot())
}

// validateConfig keeps the privileged boundary narrow. Aura accepts only the
// client building blocks it generates; file-loading and server/listener
// features are deliberately unavailable through the helper API.
func validateConfig(raw json.RawMessage) error {
	var cfg map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &cfg) != nil {
		return errors.New("config must be a JSON object")
	}
	allowedTop := map[string]bool{
		"log": true, "dns": true, "inbounds": true, "outbounds": true,
		"route": true, "experimental": true,
	}
	for key := range cfg {
		if !allowedTop[key] {
			return fmt.Errorf("config field %q is not allowed", key)
		}
	}
	logConfig, ok := cfg["log"].(map[string]any)
	if !ok || logConfig["output"] != "sing-box.log" {
		return errors.New("log output must be sing-box.log")
	}
	if err := validateTypedList(cfg["inbounds"], map[string]bool{"tun": true, "mixed": true}); err != nil {
		return fmt.Errorf("inbounds: %w", err)
	}
	if err := validateTypedList(cfg["outbounds"], map[string]bool{
		"naive": true, "urltest": true, "direct": true, "block": true,
	}); err != nil {
		return fmt.Errorf("outbounds: %w", err)
	}
	if containsUnsafePath(cfg, "") {
		return errors.New("config contains a file path outside the managed runtime")
	}
	return nil
}

func validateTypedList(value any, allowed map[string]bool) error {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return errors.New("must be a non-empty array")
	}
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return errors.New("entries must be objects")
		}
		typ, _ := object["type"].(string)
		if !allowed[typ] {
			return fmt.Errorf("type %q is not allowed", typ)
		}
	}
	return nil
}

func containsUnsafePath(value any, parent string) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "path") || strings.Contains(lower, "directory") {
				if parent == "cache_file" && key == "path" && child == "cache.db" {
					continue
				}
				return true
			}
			if containsUnsafePath(child, key) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsUnsafePath(child, parent) {
				return true
			}
		}
	}
	return false
}

func (c *core) stopHandler(w http.ResponseWriter, _ *http.Request) {
	if err := c.stop(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c.snapshot())
}

func (c *core) start() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != nil {
		return nil
	}
	config := filepath.Join(c.stateDir, "config.json")
	if _, err := os.Stat(config); err != nil {
		return fmt.Errorf("config unavailable: %w", err)
	}
	check := exec.Command(c.engine, "check", "-D", c.stateDir, "-c", config)
	check.Dir = c.stateDir
	if output, err := check.CombinedOutput(); err != nil {
		c.lastError = strings.TrimSpace(string(output))
		return fmt.Errorf("config check failed: %s", c.lastError)
	}
	logFile, err := os.OpenFile(filepath.Join(c.stateDir, "core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	cmd := exec.Command(c.engine, "run", "-D", c.stateDir, "-c", config)
	cmd.Dir = c.stateDir
	cmd.Stdout, cmd.Stderr = logFile, logFile
	configureChild(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		c.lastError = err.Error()
		return err
	}
	c.cmd = cmd
	c.startedAt = time.Now()
	c.lastError = ""
	go c.wait(cmd, logFile)
	return nil
}

func (c *core) wait(cmd *exec.Cmd, logFile *os.File) {
	err := cmd.Wait()
	_ = logFile.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != cmd {
		return
	}
	c.cmd = nil
	if err != nil {
		c.lastError = err.Error()
	}
}

func (c *core) stop() error {
	c.mu.Lock()
	cmd := c.cmd
	c.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := terminateChild(cmd); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		done := c.cmd == nil
		c.mu.Unlock()
		if done {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cmd.Process.Kill()
}

func (c *core) logHandler(w http.ResponseWriter, _ *http.Request) {
	var b []byte
	for _, name := range []string{"helper.log", "core.log", "sing-box.log"} {
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
	const max = 16 * 1024
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
