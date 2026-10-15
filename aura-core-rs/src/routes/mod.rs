use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;
use std::time::Duration;

use crate::config::{parse_bypass_entry, AuraConfig, BypassEntry, Ipv4Net, ServerConfig};

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "macos")]
pub use darwin::{configure_routes, tun_device_name};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{configure_routes, tun_device_name};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{configure_routes, tun_device_name, wintun_path};

/// System routing installed for one tunnel session, removed by `close`.
pub trait RouteState: Send + Sync {
    fn close(&mut self) -> Result<(), String>;
    /// "" (no Tailscale), "ok" (coexisting) or "rerouted".
    fn tailscale_state(&self) -> String;
}

async fn lookup_ipv4(host: &str) -> Result<Vec<Ipv4Addr>, String> {
    let resolved = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|e| format!("resolve {host}: {e}"))?;
    Ok(resolved
        .filter_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .collect())
}

/// Resolves each transport before any default routes change, then feeds the
/// same addresses to NaiveProxy and the route bypass list. This avoids a DNS
/// round-robin answer sending the encrypted transport back into its own TUN.
pub async fn pin_server_ipv4(servers: &[ServerConfig]) -> Result<Vec<ServerConfig>, String> {
    let mut pinned = servers.to_vec();
    for server in &mut pinned {
        let ip = match server.connect_address.parse::<IpAddr>() {
            Ok(IpAddr::V4(v4)) => Some(v4),
            Ok(IpAddr::V6(v6)) => v6.to_ipv4_mapped(),
            Err(_) => lookup_ipv4(&server.connect_address)
                .await?
                .into_iter()
                .next(),
        };
        let Some(ip) = ip else {
            return Err(format!(
                "server {} has no IPv4 address",
                server.connect_address
            ));
        };
        server.connect_address = ip.to_string();
    }
    Ok(pinned)
}

/// The bypass list: every server address, already pinned to IPv4 literals.
pub fn server_ipv4(servers: &[ServerConfig]) -> Result<Vec<Ipv4Addr>, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for server in servers {
        let ip: Ipv4Addr = server
            .connect_address
            .parse()
            .map_err(|_| format!("server {} has no IPv4 address", server.connect_address))?;
        if seen.insert(ip) {
            values.push(ip);
        }
    }
    Ok(values)
}

const LAN_RANGES: [(Ipv4Addr, u8); 4] = [
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
];

/// Every network routed around the tunnel: the servers (so the transport
/// never loops into its own TUN), then the user's split tunneling list.
/// Domains are resolved now, before any route changes, with the system
/// resolver; one that fails to resolve is logged and skipped rather than
/// blocking the connection.
pub async fn bypass_networks(cfg: &AuraConfig) -> Result<Vec<Ipv4Net>, String> {
    let mut nets: Vec<Ipv4Net> = server_ipv4(&cfg.servers)?
        .into_iter()
        .map(Ipv4Net::host)
        .collect();
    if cfg.split.bypass_lan {
        nets.extend(
            LAN_RANGES
                .iter()
                .map(|&(ip, prefix)| Ipv4Net::new(ip, prefix)),
        );
    }
    let mut lookups = tokio::task::JoinSet::new();
    for raw in &cfg.split.bypass {
        match parse_bypass_entry(raw)? {
            BypassEntry::Net(net) => nets.push(net),
            BypassEntry::Domain(domain) => {
                lookups.spawn(resolve_bypass_domain(domain));
            }
        }
    }
    while let Some(resolved) = lookups.join_next().await {
        nets.extend(resolved.unwrap_or_default().into_iter().map(Ipv4Net::host));
    }
    let mut seen = HashSet::new();
    nets.retain(|net| seen.insert(*net));
    Ok(nets)
}

/// A domain's IPv4 addresses plus its www. twin's, since sites usually live
/// on both.
async fn resolve_bypass_domain(domain: String) -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    for name in [domain.clone(), format!("www.{domain}")] {
        let lookup = tokio::time::timeout(Duration::from_secs(3), lookup_ipv4(&name)).await;
        if let Ok(Ok(found)) = lookup {
            ips.extend(found);
        }
    }
    if ips.is_empty() {
        log::warn!("split tunneling: {domain} did not resolve; it stays on the tunnel");
    }
    ips
}

pub fn run_command<S: AsRef<str>>(name: &str, args: &[S]) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    let mut cmd = Command::new(name);
    cmd.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::process::CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("{name} {}: {e}", args.join(" ")))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        Ok(text)
    } else {
        Err(format!(
            "{name} {}: {}: {}",
            args.join(" "),
            output.status,
            text.trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(addr: &str) -> ServerConfig {
        ServerConfig {
            tag: "t".into(),
            host: "t.example".into(),
            connect_address: addr.into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn pins_ipv4_and_rejects_ipv6_only() {
        let pinned = pin_server_ipv4(&[server("192.0.2.40")]).await.unwrap();
        assert_eq!(pinned[0].connect_address, "192.0.2.40");
        assert!(pin_server_ipv4(&[server("2001:db8::1")]).await.is_err());
    }

    #[tokio::test]
    async fn bypass_networks_merge_servers_lan_and_split_entries() {
        let cfg = crate::config::parse_config(
            r#"{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},
               "servers":[{"tag":"t","host":"t.example","connect_address":"192.0.2.1","port":443,"username":"u","password":"p"}],
               "split":{"bypass_lan":true,"bypass":["192.0.2.1","198.51.100.7/24","localhost.invalid"]}}"#,
        )
        .unwrap();
        let nets: Vec<String> = bypass_networks(&cfg)
            .await
            .unwrap()
            .iter()
            .map(|n| n.to_string())
            .collect();
        assert_eq!(
            nets,
            [
                "192.0.2.1/32",
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
                "198.51.100.0/24",
            ]
        );
    }

    #[test]
    fn bypass_list_is_deduplicated() {
        let ips = server_ipv4(&[
            server("192.0.2.1"),
            server("192.0.2.1"),
            server("192.0.2.2"),
        ])
        .unwrap();
        assert_eq!(ips.len(), 2);
    }
}
