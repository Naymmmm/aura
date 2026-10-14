use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;

use crate::config::ServerConfig;

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

pub fn run_command(name: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(name);
    cmd.args(args);
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
