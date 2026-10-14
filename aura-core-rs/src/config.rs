use std::collections::HashSet;
use std::net::IpAddr;

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
    fn rejects_trailing_json() {
        assert!(parse_config(&format!("{VALID} {{}}")).is_err());
    }
}
