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
	  "version":1,
	  "tun":{"address":"172.19.0.1/30","mtu":1400},
	  "servers":[{"tag":"romeo","host":"romeo.example.com","connect_address":"192.0.2.2","port":443,"username":"u","password":"p"}]
    }`)
	if _, err := parseConfig(valid); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for name, raw := range map[string]string{
		"unknown field": `{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},"servers":[],"path":"/etc/passwd"}`,
		"unsafe host":   `{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},"servers":[{"tag":"x","host":"/etc/passwd","connect_address":"x.example","port":443,"username":"u","password":"p"}]}`,
		"bad TUN":       `{"version":1,"tun":{"address":"0.0.0.0/0","mtu":1400},"servers":[{"tag":"x","host":"x.example","connect_address":"x.example","port":443,"username":"u","password":"p"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseConfig(json.RawMessage(raw)); err == nil {
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

func TestParseConfigRejectsTrailingJSON(t *testing.T) {
	raw := json.RawMessage(`{
	  "version":1,
	  "tun":{"address":"172.19.0.1/30","mtu":1400},
	  "servers":[{"tag":"romeo","host":"romeo.example.com","connect_address":"192.0.2.2","port":443,"username":"u","password":"p"}]
	} {}`)
	if _, err := parseConfig(raw); err == nil {
		t.Fatal("expected trailing JSON to be rejected")
	}
}

func TestPinServerIPv4(t *testing.T) {
	servers := []serverConfig{{Tag: "one", Host: "one.example", ConnectAddress: "192.0.2.40"}}
	pinned, err := pinServerIPv4(servers)
	if err != nil {
		t.Fatal(err)
	}
	if pinned[0].ConnectAddress != "192.0.2.40" {
		t.Fatalf("unexpected pinned address %q", pinned[0].ConnectAddress)
	}
	if _, err := pinServerIPv4([]serverConfig{{Tag: "six", ConnectAddress: "2001:db8::1"}}); err == nil {
		t.Fatal("expected IPv6-only transport address to be rejected")
	}
}
