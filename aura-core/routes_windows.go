//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
)

type windowsDefaultRoute struct {
	InterfaceIndex int    `json:"InterfaceIndex"`
	NextHop        string `json:"NextHop"`
}

type windowsRoutes struct {
	tunIndex       int
	defaultRoute   windowsDefaultRoute
	bypassPrefixes []string
	tunnelPrefixes []string
}

func tunDeviceName() string { return "Aura" }

func configureRoutes(deviceName string, cfg auraConfig) (_ routeState, err error) {
	defaultRoute, err := getWindowsDefaultRoute()
	if err != nil {
		return nil, err
	}
	bypass, err := resolveServerIPv4(cfg.Servers)
	if err != nil {
		return nil, err
	}
	output, err := runPowerShell(windowsInterfaceSetupScript(deviceName))
	if err != nil {
		return nil, err
	}
	var tunIndex int
	if _, err = fmt.Sscan(strings.TrimSpace(output), &tunIndex); err != nil || tunIndex <= 0 {
		return nil, errors.New("could not determine the Aura TUN interface index")
	}
	state := &windowsRoutes{tunIndex: tunIndex, defaultRoute: defaultRoute}
	defer func() {
		if err != nil {
			_ = state.Close()
		}
	}()
	for _, ip := range bypass {
		prefix := ip.String() + "/32"
		script := fmt.Sprintf("Get-NetRoute -DestinationPrefix '%s' -InterfaceIndex %d -NextHop '%s' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue; New-NetRoute -DestinationPrefix '%s' -InterfaceIndex %d -NextHop '%s' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null", prefix, defaultRoute.InterfaceIndex, defaultRoute.NextHop, prefix, defaultRoute.InterfaceIndex, defaultRoute.NextHop)
		if _, err = runPowerShell(script); err != nil {
			return nil, err
		}
		state.bypassPrefixes = append(state.bypassPrefixes, prefix)
	}
	for _, prefix := range []string{"0.0.0.0/1", "128.0.0.0/1", "2000::/3"} {
		nextHop := "0.0.0.0"
		if strings.Contains(prefix, ":") {
			nextHop = "::"
		}
		script := fmt.Sprintf("New-NetRoute -DestinationPrefix '%s' -InterfaceIndex %d -NextHop '%s' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null", prefix, tunIndex, nextHop)
		if _, err = runPowerShell(script); err != nil {
			return nil, err
		}
		state.tunnelPrefixes = append(state.tunnelPrefixes, prefix)
	}
	return state, nil
}

func windowsInterfaceSetupScript(deviceName string) string {
	return fmt.Sprintf(`
$ErrorActionPreference='Stop'
$name='%s'
Get-NetIPAddress -InterfaceAlias $name -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne '172.19.0.1'} | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Get-NetIPAddress -InterfaceAlias $name -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -eq 'fdfe:dcba:9876::1' -and $_.PrefixLength -ne 126} | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1' -ErrorAction SilentlyContinue)) { New-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1' -PrefixLength 30 | Out-Null }
if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1' -ErrorAction SilentlyContinue)) { New-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1' -PrefixLength 126 | Out-Null }
Set-NetIPInterface -InterfaceAlias $name -AddressFamily IPv4 -InterfaceMetric 5
Set-NetIPInterface -InterfaceAlias $name -AddressFamily IPv6 -InterfaceMetric 5
Set-DnsClientServerAddress -InterfaceAlias $name -ServerAddresses @('1.1.1.1','1.0.0.1','2606:4700:4700::1111','2606:4700:4700::1001')
(Get-NetAdapter -Name $name).ifIndex
`, strings.ReplaceAll(deviceName, "'", "''"))
}

func getWindowsDefaultRoute() (windowsDefaultRoute, error) {
	var value windowsDefaultRoute
	output, err := runPowerShell(`$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$_.NextHop -ne '0.0.0.0'} | Sort-Object RouteMetric | Select-Object -First 1 InterfaceIndex,NextHop; $r | ConvertTo-Json -Compress`)
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &value); err != nil {
		return value, fmt.Errorf("parse Windows default route: %w", err)
	}
	if value.InterfaceIndex <= 0 || net.ParseIP(value.NextHop) == nil {
		return value, errors.New("could not determine the Windows default route")
	}
	return value, nil
}

func runPowerShell(script string) (string, error) {
	return runCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
}

func (r *windowsRoutes) Close() error {
	var errs []error
	for _, prefix := range r.tunnelPrefixes {
		script := fmt.Sprintf("Get-NetRoute -DestinationPrefix '%s' -InterfaceIndex %d -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue", prefix, r.tunIndex)
		if _, err := runPowerShell(script); err != nil {
			errs = append(errs, err)
		}
	}
	for _, prefix := range r.bypassPrefixes {
		script := fmt.Sprintf("Get-NetRoute -DestinationPrefix '%s' -InterfaceIndex %d -NextHop '%s' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue", prefix, r.defaultRoute.InterfaceIndex, r.defaultRoute.NextHop)
		if _, err := runPowerShell(script); err != nil {
			errs = append(errs, err)
		}
	}
	r.tunnelPrefixes = nil
	r.bypassPrefixes = nil
	return errors.Join(errs...)
}
