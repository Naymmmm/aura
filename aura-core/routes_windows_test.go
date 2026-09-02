//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestWindowsInterfaceSetupIsIdempotent(t *testing.T) {
	script := windowsInterfaceSetupScript("Aura")

	if !strings.Contains(script, "if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1'") {
		t.Fatalf("IPv4 address creation must be guarded: %s", script)
	}
	if !strings.Contains(script, "if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1'") {
		t.Fatalf("IPv6 address creation must be guarded: %s", script)
	}
	if !strings.Contains(script, "Where-Object {$_.IPAddress -ne '172.19.0.1'}") {
		t.Fatalf("cleanup must preserve the desired IPv4 address: %s", script)
	}
}
