use std::net::{IpAddr, Ipv4Addr};

use serde::Deserialize;

use super::{run_command, server_ipv4, RouteState};
use crate::config::AuraConfig;
use crate::tailscale::tailscale_interface;

pub fn tun_device_name() -> &'static str {
    "Aura"
}

/// wintun.dll ships next to aura-core.exe.
pub fn wintun_path() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("wintun.dll")))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "wintun.dll".into())
}

#[derive(Debug, Deserialize)]
struct DefaultRoute {
    #[serde(rename = "InterfaceIndex")]
    interface_index: i64,
    #[serde(rename = "NextHop")]
    next_hop: String,
}

struct WindowsRoutes {
    tun_index: i64,
    default_route: DefaultRoute,
    bypass_prefixes: Vec<String>,
    tunnel_prefixes: Vec<&'static str>,
}

pub fn configure_routes(device: &str, cfg: &AuraConfig) -> Result<Box<dyn RouteState>, String> {
    let default_route = default_route()?;
    let bypass = server_ipv4(&cfg.servers)?;
    let output = run_powershell(&interface_setup_script(device))?;
    let tun_index: i64 = output
        .trim()
        .parse()
        .ok()
        .filter(|i| *i > 0)
        .ok_or("could not determine the Aura TUN interface index")?;
    let mut state = WindowsRoutes {
        tun_index,
        default_route,
        bypass_prefixes: Vec::new(),
        tunnel_prefixes: Vec::new(),
    };
    if let Err(e) = state.apply(&bypass) {
        let _ = state.close();
        return Err(e);
    }
    Ok(Box::new(state))
}

impl WindowsRoutes {
    fn apply(&mut self, bypass: &[Ipv4Addr]) -> Result<(), String> {
        let (if_index, next_hop) = (
            self.default_route.interface_index,
            &self.default_route.next_hop,
        );
        for ip in bypass {
            let prefix = format!("{ip}/32");
            run_powershell(&format!(
                "Get-NetRoute -DestinationPrefix '{prefix}' -InterfaceIndex {if_index} -NextHop '{next_hop}' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue; New-NetRoute -DestinationPrefix '{prefix}' -InterfaceIndex {if_index} -NextHop '{next_hop}' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null"
            ))?;
            self.bypass_prefixes.push(prefix);
        }
        for prefix in ["0.0.0.0/1", "128.0.0.0/1", "2000::/3"] {
            let hop = if prefix.contains(':') {
                "::"
            } else {
                "0.0.0.0"
            };
            run_powershell(&format!(
                "New-NetRoute -DestinationPrefix '{prefix}' -InterfaceIndex {} -NextHop '{hop}' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null",
                self.tun_index
            ))?;
            self.tunnel_prefixes.push(prefix);
        }
        Ok(())
    }
}

fn interface_setup_script(device: &str) -> String {
    format!(
        r#"
$ErrorActionPreference='Stop'
$name='{}'
Get-NetIPAddress -InterfaceAlias $name -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {{$_.IPAddress -ne '172.19.0.1'}} | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Get-NetIPAddress -InterfaceAlias $name -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object {{$_.IPAddress -eq 'fdfe:dcba:9876::1' -and $_.PrefixLength -ne 126}} | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1' -ErrorAction SilentlyContinue)) {{ New-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1' -PrefixLength 30 | Out-Null }}
if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1' -ErrorAction SilentlyContinue)) {{ New-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1' -PrefixLength 126 | Out-Null }}
Set-NetIPInterface -InterfaceAlias $name -AddressFamily IPv4 -InterfaceMetric 5
Set-NetIPInterface -InterfaceAlias $name -AddressFamily IPv6 -InterfaceMetric 5
Set-DnsClientServerAddress -InterfaceAlias $name -ServerAddresses @('1.1.1.1','1.0.0.1','2606:4700:4700::1111','2606:4700:4700::1001')
(Get-NetAdapter -Name $name).ifIndex
"#,
        device.replace('\'', "''")
    )
}

fn default_route() -> Result<DefaultRoute, String> {
    let output = run_powershell(
        "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$_.NextHop -ne '0.0.0.0'} | Sort-Object RouteMetric | Select-Object -First 1 InterfaceIndex,NextHop; $r | ConvertTo-Json -Compress",
    )?;
    let value: DefaultRoute = serde_json::from_str(output.trim())
        .map_err(|e| format!("parse Windows default route: {e}"))?;
    if value.interface_index <= 0 || value.next_hop.parse::<IpAddr>().is_err() {
        return Err("could not determine the Windows default route".into());
    }
    Ok(value)
}

fn run_powershell(script: &str) -> Result<String, String> {
    run_command(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
}

impl RouteState for WindowsRoutes {
    fn close(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for prefix in self.tunnel_prefixes.drain(..) {
            let script = format!(
                "Get-NetRoute -DestinationPrefix '{prefix}' -InterfaceIndex {} -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue",
                self.tun_index
            );
            if let Err(e) = run_powershell(&script) {
                errors.push(e);
            }
        }
        for prefix in self.bypass_prefixes.drain(..) {
            let script = format!(
                "Get-NetRoute -DestinationPrefix '{prefix}' -InterfaceIndex {} -NextHop '{}' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue",
                self.default_route.interface_index, self.default_route.next_hop
            );
            if let Err(e) = run_powershell(&script) {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }

    /// Windows Tailscale owns its routes and MagicDNS via NRPT; Aura only uses
    /// /1 splits, which never outrank Tailscale's more-specific tailnet routes.
    fn tailscale_state(&self) -> String {
        if tailscale_interface().is_empty() {
            String::new()
        } else {
            "ok".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_setup_is_idempotent() {
        let script = interface_setup_script("Aura");
        assert!(script
            .contains("if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress '172.19.0.1'"));
        assert!(script.contains(
            "if (-not (Get-NetIPAddress -InterfaceAlias $name -IPAddress 'fdfe:dcba:9876::1'"
        ));
        assert!(script.contains("Where-Object {$_.IPAddress -ne '172.19.0.1'}"));
    }
}
