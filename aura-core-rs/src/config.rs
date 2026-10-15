use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuraConfig {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub tun: TunConfig,
    #[serde(default)]
    pub servers: Vec<ServerConfig>,
    #[serde(default)]
    pub split: SplitConfig,
}

/// Traffic that skips the tunnel and leaves through the normal gateway.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SplitConfig {
    /// Private ranges (10/8, 172.16/12, 192.168/16, 169.254/16).
    #[serde(default)]
    pub bypass_lan: bool,
    /// IPv4 addresses, IPv4 CIDRs (/8 or narrower) and domain names.
    #[serde(default)]
    pub bypass: Vec<String>,
}

pub const MAX_BYPASS_ENTRIES: usize = 128;

/// One split tunneling entry, as the user typed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BypassEntry {
    Net(Ipv4Net),
    Domain(String),
}

/// An IPv4 network with its host bits cleared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ipv4Net {
    pub addr: Ipv4Addr,
    pub prefix: u8,
}

impl Ipv4Net {
    pub fn new(addr: Ipv4Addr, prefix: u8) -> Ipv4Net {
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix)
        };
        Ipv4Net {
            addr: Ipv4Addr::from(u32::from(addr) & mask),
            prefix,
        }
    }

    pub fn host(addr: Ipv4Addr) -> Ipv4Net {
        Ipv4Net { addr, prefix: 32 }
    }
}

impl std::fmt::Display for Ipv4Net {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// Anything wider than a /8 would outrank none of the tunnel's own routes on
/// macOS and would hand most of the internet to the local network.
const MIN_BYPASS_PREFIX: u8 = 8;

pub fn parse_bypass_entry(raw: &str) -> Result<BypassEntry, String> {
    let value = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    let value = value.strip_prefix("*.").unwrap_or(&value);
    if let Some((ip, prefix)) = value.split_once('/') {
        let ip: Ipv4Addr = ip
            .parse()
            .map_err(|_| format!("{raw:?} is not an IPv4 range"))?;
        let prefix: u8 = prefix
            .parse()
            .ok()
            .filter(|p| (MIN_BYPASS_PREFIX..=32).contains(p))
            .ok_or_else(|| format!("{raw:?} must be a /8 to /32 range"))?;
        return Ok(BypassEntry::Net(Ipv4Net::new(ip, prefix)));
    }
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => return Ok(BypassEntry::Net(Ipv4Net::host(ip))),
        Ok(IpAddr::V6(_)) => return Err(format!("{raw:?}: IPv6 can't be bypassed yet")),
        Err(_) => {}
    }
    if value.contains('.') && valid_host(value) {
        Ok(BypassEntry::Domain(value.to_string()))
    } else {
        Err(format!("{raw:?} is not an IPv4 address, range or domain"))
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TunConfig {
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub mtu: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub connect_address: String,
    #[serde(default)]
    pub port: i64,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

/// Parses and validates the only config shape Aura Core accepts. Anything
/// else (server inbounds, filesystem paths, extra fields) is rejected before
/// the privileged process writes it anywhere.
pub fn parse_config(raw: &str) -> Result<AuraConfig, String> {
    let mut de = serde_json::Deserializer::from_str(raw);
    let cfg = AuraConfig::deserialize(&mut de)
        .map_err(|_| "config must match the Aura Core schema".to_string())?;
    if de.end().is_err() {
        return Err("config must contain exactly one JSON object".into());
    }
    if cfg.version != 1 {
        return Err("unsupported config version".into());
    }
    if cfg.tun.address != "172.19.0.1/30" {
        return Err("unsupported TUN address".into());
    }
    if !(1280..=1500).contains(&cfg.tun.mtu) {
        return Err("TUN MTU must be between 1280 and 1500".into());
    }
    if cfg.servers.is_empty() || cfg.servers.len() > 8 {
        return Err("config must contain 1 to 8 servers".into());
    }
    let mut seen = HashSet::new();
    for (i, server) in cfg.servers.iter().enumerate() {
        if !valid_tag(&server.tag) || !seen.insert(server.tag.as_str()) {
            return Err(format!("server {i} has an invalid or duplicate tag"));
        }
        if !valid_host(&server.host) || !valid_host(&server.connect_address) {
            return Err(format!("server {:?} has an invalid address", server.tag));
        }
        if !(1..=65535).contains(&server.port) {
            return Err(format!("server {:?} has an invalid port", server.tag));
        }
        let bad = |s: &str| s.is_empty() || s.len() > 255;
        if bad(&server.username) || bad(&server.password) {
            return Err(format!("server {:?} has invalid credentials", server.tag));
        }
    }
    if cfg.split.bypass.len() > MAX_BYPASS_ENTRIES {
        return Err(format!(
            "split tunneling allows at most {MAX_BYPASS_ENTRIES} entries"
        ));
    }
    for entry in &cfg.split.bypass {
        parse_bypass_entry(entry)?;
    }
    Ok(cfg)
}

fn valid_tag(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn valid_host(value: &str) -> bool {
    if value.is_empty() || value.contains([' ', '/', '\\', '\t', '\r', '\n']) {
        return false;
    }
    if value.parse::<IpAddr>().is_ok() {
        return true;
    }
    (1..=253).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        && !value.starts_with('.')
        && !value.ends_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
      "version":1,
      "tun":{"address":"172.19.0.1/30","mtu":1400},
      "servers":[{"tag":"romeo","host":"romeo.example.com","connect_address":"192.0.2.2","port":443,"username":"u","password":"p"}]
    }"#;

    #[test]
    fn accepts_valid_config() {
        parse_config(VALID).expect("valid config rejected");
    }

    #[test]
    fn rejects_unsafe_configs() {
        for raw in [
            r#"{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},"servers":[],"path":"/etc/passwd"}"#,
            r#"{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},"servers":[{"tag":"x","host":"/etc/passwd","connect_address":"x.example","port":443,"username":"u","password":"p"}]}"#,
            r#"{"version":1,"tun":{"address":"0.0.0.0/0","mtu":1400},"servers":[{"tag":"x","host":"x.example","connect_address":"x.example","port":443,"username":"u","password":"p"}]}"#,
        ] {
            assert!(
                parse_config(raw).is_err(),
                "unsafe config was accepted: {raw}"
            );
        }
    }

    #[test]
    fn accepts_split_tunneling_and_rejects_bad_entries() {
        let with = |split: &str| {
            VALID.replacen("\"servers\"", &format!("\"split\":{split},\"servers\""), 1)
        };
        let cfg = parse_config(&with(
            r#"{"bypass_lan":true,"bypass":["10.1.2.3","192.168.7.9/16","*.Netflix.com."]}"#,
        ))
        .unwrap();
        assert!(cfg.split.bypass_lan);
        assert_eq!(
            cfg.split
                .bypass
                .iter()
                .map(|e| parse_bypass_entry(e).unwrap())
                .collect::<Vec<_>>(),
            vec![
                BypassEntry::Net(Ipv4Net::host("10.1.2.3".parse().unwrap())),
                BypassEntry::Net(Ipv4Net::new("192.168.0.0".parse().unwrap(), 16)),
                BypassEntry::Domain("netflix.com".into()),
            ]
        );
        for bad in [
            r#"{"bypass":["0.0.0.0/0"]}"#,
            r#"{"bypass":["1.0.0.0/4"]}"#,
            r#"{"bypass":["2001:db8::1"]}"#,
            r#"{"bypass":["localhost"]}"#,
            r#"{"bypass":["a b.com"]}"#,
            r#"{"exclude":[]}"#,
        ] {
            assert!(parse_config(&with(bad)).is_err(), "accepted {bad}");
        }
        let too_many = format!(
            r#"{{"bypass":[{}]}}"#,
            vec!["\"1.1.1.1\""; MAX_BYPASS_ENTRIES + 1].join(",")
        );
        assert!(parse_config(&with(&too_many)).is_err());
    }

    #[test]
    fn rejects_trailing_json() {
        assert!(parse_config(&format!("{VALID} {{}}")).is_err());
    }
}
