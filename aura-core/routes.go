package main

import (
	"fmt"
	"net"
	"os/exec"
	"strings"
)

func resolveServerIPv4(servers []serverConfig) ([]net.IP, error) {
	seen := make(map[string]bool)
	var values []net.IP
	for _, server := range servers {
		if ip := net.ParseIP(server.ConnectAddress); ip != nil {
			if ip4 := ip.To4(); ip4 != nil && !seen[ip4.String()] {
				seen[ip4.String()] = true
				values = append(values, ip4)
			}
			continue
		}
		resolved, err := net.LookupIP(server.ConnectAddress)
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", server.ConnectAddress, err)
		}
		found := false
		for _, ip := range resolved {
			if ip4 := ip.To4(); ip4 != nil {
				found = true
				if !seen[ip4.String()] {
					seen[ip4.String()] = true
					values = append(values, ip4)
				}
			}
		}
		if !found {
			return nil, fmt.Errorf("server %s has no IPv4 address", server.ConnectAddress)
		}
	}
	return values, nil
}

// pinServerIPv4 resolves each transport before any default routes change, then
// feeds the same addresses to NaiveProxy and the route bypass list. This avoids
// a DNS round-robin answer sending the encrypted transport back into its own
// TUN interface.
func pinServerIPv4(servers []serverConfig) ([]serverConfig, error) {
	pinned := append([]serverConfig(nil), servers...)
	for i, server := range pinned {
		if ip := net.ParseIP(server.ConnectAddress); ip != nil {
			if ip4 := ip.To4(); ip4 != nil {
				pinned[i].ConnectAddress = ip4.String()
				continue
			}
			return nil, fmt.Errorf("server %s has no IPv4 address", server.ConnectAddress)
		}
		resolved, err := net.LookupIP(server.ConnectAddress)
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", server.ConnectAddress, err)
		}
		for _, ip := range resolved {
			if ip4 := ip.To4(); ip4 != nil {
				pinned[i].ConnectAddress = ip4.String()
				break
			}
		}
		if net.ParseIP(pinned[i].ConnectAddress) == nil {
			return nil, fmt.Errorf("server %s has no IPv4 address", server.ConnectAddress)
		}
	}
	return pinned, nil
}

func runCommand(name string, args ...string) (string, error) {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
