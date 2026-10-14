//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strings"
)

type linuxRoutes struct {
	device      string
	gateway     string
	gatewayDev  string
	bypass      []net.IP
	tunnelCIDRs []string
	ipv6Route   bool
	dns         bool
}

func tunDeviceName() string { return "aura0" }

func configureRoutes(deviceName string, cfg auraConfig) (_ routeState, err error) {
	gateway, gatewayDev, err := linuxDefaultGateway()
	if err != nil {
		return nil, err
	}
	bypass, err := resolveServerIPv4(cfg.Servers)
	if err != nil {
		return nil, err
	}
	state := &linuxRoutes{device: deviceName, gateway: gateway, gatewayDev: gatewayDev}
	defer func() {
		if err != nil {
			_ = state.Close()
		}
	}()
	if _, err = runCommand("ip", "addr", "replace", "172.19.0.1/30", "dev", deviceName); err != nil {
		return nil, err
	}
	if _, err = runCommand("ip", "-6", "addr", "replace", "fdfe:dcba:9876::1/126", "dev", deviceName); err != nil {
		// IPv6 may be disabled system-wide; IPv4 still works.
		err = nil
	}
	if _, err = runCommand("ip", "link", "set", "dev", deviceName, "mtu", fmt.Sprint(cfg.TUN.MTU), "up"); err != nil {
		return nil, err
	}
	for _, ip := range bypass {
		if _, err = runCommand("ip", "route", "replace", ip.String()+"/32", "via", gateway, "dev", gatewayDev); err != nil {
			return nil, err
		}
		state.bypass = append(state.bypass, ip)
	}
	// Two /1s beat the default route without replacing it. Tailscale's tailnet
	// lives in its own policy table (52), consulted before main, so peers and
	// MagicDNS keep working untouched.
	for _, cidr := range []string{"0.0.0.0/1", "128.0.0.0/1"} {
		if _, err = runCommand("ip", "route", "replace", cidr, "dev", deviceName); err != nil {
			return nil, err
		}
		state.tunnelCIDRs = append(state.tunnelCIDRs, cidr)
	}
	if _, v6err := runCommand("ip", "-6", "route", "replace", "2000::/3", "dev", deviceName); v6err == nil {
		state.ipv6Route = true
	}
	// Send DNS through the tunnel too (filtered networks rewrite DNS), the
	// same resolvers the Windows build uses. systemd-resolved drops these
	// automatically when the link goes away.
	if _, lookErr := exec.LookPath("resolvectl"); lookErr == nil {
		if _, dnsErr := runCommand("resolvectl", "dns", deviceName, "1.1.1.1", "1.0.0.1"); dnsErr == nil {
			_, _ = runCommand("resolvectl", "domain", deviceName, "~.")
			state.dns = true
		}
	}
	return state, nil
}

func linuxDefaultGateway() (gateway, dev string, err error) {
	output, err := runCommand("ip", "-4", "route", "show", "default")
	if err != nil {
		return "", "", err
	}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		for i := 0; i+1 < len(fields); i++ {
			switch fields[i] {
			case "via":
				if gateway == "" {
					gateway = fields[i+1]
				}
			case "dev":
				if dev == "" {
					dev = fields[i+1]
				}
			}
		}
		if gateway != "" && dev != "" && dev != tunDeviceName() {
			return gateway, dev, nil
		}
		gateway, dev = "", ""
	}
	return "", "", errors.New("could not determine the Linux default gateway")
}

func (r *linuxRoutes) TailscaleState() string {
	if tailscaleInterface() != "" {
		return "ok"
	}
	return ""
}

func (r *linuxRoutes) Close() error {
	var errs []error
	if r.dns {
		_, _ = runCommand("resolvectl", "revert", r.device)
		r.dns = false
	}
	if r.ipv6Route {
		_, _ = runCommand("ip", "-6", "route", "del", "2000::/3", "dev", r.device)
		r.ipv6Route = false
	}
	for i := len(r.tunnelCIDRs) - 1; i >= 0; i-- {
		if _, err := runCommand("ip", "route", "del", r.tunnelCIDRs[i], "dev", r.device); err != nil && !strings.Contains(err.Error(), "No such process") {
			errs = append(errs, err)
		}
	}
	for i := len(r.bypass) - 1; i >= 0; i-- {
		if _, err := runCommand("ip", "route", "del", r.bypass[i].String()+"/32", "via", r.gateway, "dev", r.gatewayDev); err != nil && !strings.Contains(err.Error(), "No such process") {
			errs = append(errs, err)
		}
	}
	r.tunnelCIDRs = nil
	r.bypass = nil
	return errors.Join(errs...)
}
