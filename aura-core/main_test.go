package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthenticate(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := authenticate("correct-token", next)
	for _, tc := range []struct {
		name  string
		token string
		want  int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "wrong", http.StatusUnauthorized},
		{"correct", "correct-token", http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
			if tc.token != "" {
				r.Header.Set("Authorization", "Bearer "+tc.token)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func TestValidateConfig(t *testing.T) {
	valid := json.RawMessage(`{
      "log":{"output":"sing-box.log"},
      "inbounds":[{"type":"tun"},{"type":"mixed"}],
      "outbounds":[{"type":"naive"},{"type":"urltest"}],
      "experimental":{"cache_file":{"path":"cache.db"}}
    }`)
	if err := validateConfig(valid); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for name, raw := range map[string]string{
		"absolute log":   `{"log":{"output":"/etc/passwd"},"inbounds":[{"type":"tun"}],"outbounds":[{"type":"naive"}]}`,
		"server inbound": `{"log":{"output":"sing-box.log"},"inbounds":[{"type":"naive"}],"outbounds":[{"type":"direct"}]}`,
		"file path":      `{"log":{"output":"sing-box.log"},"inbounds":[{"type":"tun"}],"outbounds":[{"type":"naive","certificate_path":"/private/key"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateConfig(json.RawMessage(raw)); err == nil {
				t.Fatal("unsafe config was accepted")
			}
		})
	}
}

func TestSnapshotStartsStopped(t *testing.T) {
	c := &core{}
	s := c.snapshot()
	if s.Running || s.Version != version {
		t.Fatalf("unexpected status: %+v", s)
	}
}
