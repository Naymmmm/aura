package main

import "net"

// Tailscale hands out addresses from the CGNAT range (and a fixed IPv6 ULA).
// Aura never tunnels these: tailnet traffic must stay on Tailscale's own
// interface or peers, MagicDNS (100.100.100.100) and subnet routes break.
var (
	tailnetIPv4 = mustCIDR("100.64.0.0/10")
	tailnetIPv6 = mustCIDR("fd7a:115c:a1e0::/48")
)

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// tailscaleInterface returns the name of the interface Tailscale is running
// on (utunN on macOS, tailscale0 on Linux, "Tailscale" on Windows), or "" if
// Tailscale isn't up. Detection is by address, so it works for the App Store,
// standalone and open-source builds alike.
func tailscaleInterface() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		// Skip down links and anything with a MAC: carrier-grade NAT ISPs hand
		// 100.64/10 addresses to real Wi-Fi/Ethernet too, but Tailscale is a TUN.
		if iface.Flags&net.FlagUp == 0 || len(iface.HardwareAddr) > 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			if tailnetIPv4.Contains(ipNet.IP) || tailnetIPv6.Contains(ipNet.IP) {
				return iface.Name
			}
		}
	}
	return ""
}
