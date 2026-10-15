use super::{run_command, RouteState};
use crate::config::Ipv4Net;
use crate::tailscale::tailscale_interface;

pub fn tun_device_name() -> &'static str {
    "aura0"
}

struct LinuxRoutes {
    device: String,
    gateway: String,
    gateway_dev: String,
    bypass: Vec<Ipv4Net>,
    tunnel_cidrs: Vec<&'static str>,
    ipv6_route: bool,
    dns: bool,
}

pub fn configure_routes(
    device: &str,
    mtu: i64,
    bypass: &[Ipv4Net],
) -> Result<Box<dyn RouteState>, String> {
    let (gateway, gateway_dev) = default_gateway()?;
    let mut state = LinuxRoutes {
        device: device.to_string(),
        gateway,
        gateway_dev,
        bypass: Vec::new(),
        tunnel_cidrs: Vec::new(),
        ipv6_route: false,
        dns: false,
    };
    if let Err(e) = state.apply(mtu, bypass) {
        let _ = state.close();
        return Err(e);
    }
    Ok(Box::new(state))
}

impl LinuxRoutes {
    fn apply(&mut self, mtu: i64, bypass: &[Ipv4Net]) -> Result<(), String> {
        let dev = self.device.clone();
        run_command("ip", &["addr", "replace", "172.19.0.1/30", "dev", &dev])?;
        // IPv6 may be disabled system-wide; IPv4 still works.
        let _ = run_command(
            "ip",
            &[
                "-6",
                "addr",
                "replace",
                "fdfe:dcba:9876::1/126",
                "dev",
                &dev,
            ],
        );
        run_command(
            "ip",
            &["link", "set", "dev", &dev, "mtu", &mtu.to_string(), "up"],
        )?;
        for net in bypass {
            let prefix = net.to_string();
            run_command(
                "ip",
                &[
                    "route",
                    "replace",
                    &prefix,
                    "via",
                    &self.gateway,
                    "dev",
                    &self.gateway_dev,
                ],
            )?;
            self.bypass.push(*net);
        }
        // Two /1s beat the default route without replacing it. Tailscale's
        // tailnet lives in its own policy table (52), consulted before main,
        // so peers and MagicDNS keep working untouched.
        for cidr in ["0.0.0.0/1", "128.0.0.0/1"] {
            run_command("ip", &["route", "replace", cidr, "dev", &dev])?;
            self.tunnel_cidrs.push(cidr);
        }
        if run_command("ip", &["-6", "route", "replace", "2000::/3", "dev", &dev]).is_ok() {
            self.ipv6_route = true;
        }
        // Send DNS through the tunnel too (filtered networks rewrite DNS), the
        // same resolvers the Windows build uses. systemd-resolved drops these
        // automatically when the link goes away.
        if run_command("resolvectl", &["dns", &dev, "1.1.1.1", "1.0.0.1"]).is_ok() {
            let _ = run_command("resolvectl", &["domain", &dev, "~."]);
            self.dns = true;
        }
        Ok(())
    }
}

fn default_gateway() -> Result<(String, String), String> {
    let output = run_command("ip", &["-4", "route", "show", "default"])?;
    parse_default_gateway(&output)
        .ok_or_else(|| "could not determine the Linux default gateway".into())
}

fn parse_default_gateway(output: &str) -> Option<(String, String)> {
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let after = |key: &str| {
            fields
                .windows(2)
                .find(|w| w[0] == key)
                .map(|w| w[1].to_string())
        };
        if let (Some(gateway), Some(dev)) = (after("via"), after("dev")) {
            if dev != tun_device_name() {
                return Some((gateway, dev));
            }
        }
    }
    None
}

impl RouteState for LinuxRoutes {
    fn close(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        let missing = |e: &String| e.contains("No such process");
        if self.dns {
            let _ = run_command("resolvectl", &["revert", &self.device]);
            self.dns = false;
        }
        if self.ipv6_route {
            let _ = run_command(
                "ip",
                &["-6", "route", "del", "2000::/3", "dev", &self.device],
            );
            self.ipv6_route = false;
        }
        for cidr in self.tunnel_cidrs.drain(..).rev() {
            if let Err(e) = run_command("ip", &["route", "del", cidr, "dev", &self.device]) {
                if !missing(&e) {
                    errors.push(e);
                }
            }
        }
        for net in self.bypass.drain(..).rev() {
            let prefix = net.to_string();
            if let Err(e) = run_command(
                "ip",
                &[
                    "route",
                    "del",
                    &prefix,
                    "via",
                    &self.gateway,
                    "dev",
                    &self.gateway_dev,
                ],
            ) {
                if !missing(&e) {
                    errors.push(e);
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }

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
    fn parses_default_gateway_skipping_aura() {
        let output = "default dev aura0 scope link\ndefault via 192.168.1.1 dev wlan0 proto dhcp metric 600\n";
        assert_eq!(
            parse_default_gateway(output),
            Some(("192.168.1.1".into(), "wlan0".into()))
        );
    }
}
