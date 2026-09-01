package main

import (
	"net"
	"os"
	"testing"
	"time"
)

func TestNaiveProxyMultiListenerIntegration(t *testing.T) {
	executable := os.Getenv("AURA_NAIVE_PATH")
	if executable == "" {
		t.Skip("set AURA_NAIVE_PATH to test the bundled NaiveProxy binary")
	}
	servers := []serverConfig{
		{Tag: "one", Host: "one.example", ConnectAddress: "192.0.2.10", Port: 443, Username: "u", Password: "p"},
		{Tag: "two", Host: "two.example", ConnectAddress: "192.0.2.11", Port: 443, Username: "u", Password: "p"},
	}
	process, endpoints, err := startNaive(t.TempDir(), executable, servers)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Stop()
	if len(endpoints) != len(servers) {
		t.Fatalf("got %d endpoints, want %d", len(endpoints), len(servers))
	}
	for _, endpoint := range endpoints {
		conn, err := net.DialTimeout("tcp", endpoint.addr, time.Second)
		if err != nil {
			t.Fatalf("listener %s: %v", endpoint.tag, err)
		}
		_ = conn.Close()
	}
}
