//go:build darwin

package main

import "testing"

func TestParseDarwinTailnetRoute(t *testing.T) {
	hijacked := `   route to: 100.64.0.0
destination: 100.64.0.0
       mask: 255.192.0.0
    gateway: 10.174.128.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>`
	if gw, iface := parseDarwinTailnetRoute(hijacked); gw != "10.174.128.1" || iface != "en0" {
		t.Fatalf("got %q %q", gw, iface)
	}

	// A lookup that only matched the default route must not count as a
	// 100.64/10 route, or Close would "restore" something Aura never saw.
	broader := `   route to: 100.64.0.0
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0`
	if gw, iface := parseDarwinTailnetRoute(broader); gw != "" || iface != "" {
		t.Fatalf("broader route matched: %q %q", gw, iface)
	}
}
