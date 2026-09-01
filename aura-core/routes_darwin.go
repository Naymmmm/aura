//go:build darwin

package main

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

var tunnelIPv4Routes = []string{
	"1.0.0.0/8", "2.0.0.0/7", "4.0.0.0/6", "8.0.0.0/5",
	"16.0.0.0/4", "32.0.0.0/3", "64.0.0.0/2", "128.0.0.0/1",
}

type darwinRoutes struct {
	gateway     string
	bypass      []net.IP
	tunnelCIDRs []string
	ipv6Route   bool
}

func tunDeviceName() string { return "utun123" }

func configureRoutes(deviceName string, cfg auraConfig) (_ routeState, err error) {
	gateway, err := darwinDefaultGateway()
	if err != nil {
		return nil, err
	}
	bypass, err := resolveServerIPv4(cfg.Servers)
	if err != nil {
		return nil, err
	}
	state := &darwinRoutes{gateway: gateway}
	defer func() {
		if err != nil {
			_ = state.Close()
		}
	}()
	if _, err = runCommand("/sbin/ifconfig", deviceName, "inet", "172.19.0.1", "172.19.0.1", "netmask", "255.255.255.252", "mtu", fmt.Sprint(cfg.TUN.MTU), "up"); err != nil {
		return nil, err
	}
	if _, err = runCommand("/sbin/ifconfig", deviceName, "inet6", "fdfe:dcba:9876::1", "prefixlen", "126", "alias"); err != nil {
		return nil, err
	}
	for _, ip := range bypass {
		if _, addErr := runCommand("/sbin/route", "-n", "add", "-host", ip.String(), gateway); addErr == nil {
			state.bypass = append(state.bypass, ip)
		} else if !strings.Contains(addErr.Error(), "File exists") {
			return nil, addErr
		}
	}
	for _, cidr := range tunnelIPv4Routes {
		if _, err = runCommand("/sbin/route", "-n", "add", "-net", cidr, "172.19.0.1"); err != nil {
			return nil, err
		}
		state.tunnelCIDRs = append(state.tunnelCIDRs, cidr)
	}
	if _, err = runCommand("/sbin/route", "-n", "add", "-inet6", "-net", "2000::/3", "-interface", deviceName); err != nil {
		return nil, err
	}
	state.ipv6Route = true
	return state, nil
}

func darwinDefaultGateway() (string, error) {
	output, err := runCommand("/sbin/route", "-n", "get", "default")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "gateway:" && net.ParseIP(fields[1]) != nil {
			return fields[1], nil
		}
	}
	return "", errors.New("could not determine the macOS default gateway")
}

func (r *darwinRoutes) Close() error {
	var errs []error
	if r.ipv6Route {
		if _, err := runCommand("/sbin/route", "-n", "delete", "-inet6", "-net", "2000::/3"); err != nil {
			errs = append(errs, err)
		}
		r.ipv6Route = false
	}
	for i := len(r.tunnelCIDRs) - 1; i >= 0; i-- {
		if _, err := runCommand("/sbin/route", "-n", "delete", "-net", r.tunnelCIDRs[i], "172.19.0.1"); err != nil {
			errs = append(errs, err)
		}
	}
	for i := len(r.bypass) - 1; i >= 0; i-- {
		if _, err := runCommand("/sbin/route", "-n", "delete", "-host", r.bypass[i].String(), r.gateway); err != nil {
			errs = append(errs, err)
		}
	}
	r.tunnelCIDRs = nil
	r.bypass = nil
	return errors.Join(errs...)
}
