use std::net::IpAddr;

use super::{run_command, RouteState};
use crate::config::Ipv4Net;
use crate::tailscale::tailscale_interface;

const ROUTE: &str = "/sbin/route";
const IFCONFIG: &str = "/sbin/ifconfig";
const TAILNET: &str = "100.64.0.0/10";

const TUNNEL_IPV4_ROUTES: [&str; 8] = [
    "1.0.0.0/8",
    "2.0.0.0/7",
    "4.0.0.0/6",
    "8.0.0.0/5",
    "16.0.0.0/4",
    "32.0.0.0/3",
    "64.0.0.0/2",
    "128.0.0.0/1",
];

pub fn tun_device_name() -> &'static str {
    "utun123"
}

struct DarwinRoutes {
    gateway: String,
    bypass: Vec<Ipv4Net>,
    tunnel_cidrs: Vec<&'static str>,
    ipv6_route: bool,
    tailnet: TailnetRoute,
}

/// How Aura pointed 100.64.0.0/10 at Tailscale, so close can put things back
/// exactly as they were.
#[derive(Default)]
struct TailnetRoute {
    /// Tailscale's utun, "" when untouched.
    iface: String,
    /// Aura created the route.
    added: bool,
    /// Previous gateway/interface when Aura changed an existing route.
    prev_gw: String,
    prev_iface: String,
}

pub fn configure_routes(
    device: &str,
    mtu: i64,
    bypass: &[Ipv4Net],
) -> Result<Box<dyn RouteState>, String> {
    let gateway = default_gateway()?;
    let mut state = DarwinRoutes {
        gateway,
        bypass: Vec::new(),
        tunnel_cidrs: Vec::new(),
        ipv6_route: false,
        tailnet: TailnetRoute::default(),
    };
    if let Err(e) = state.apply(device, mtu, bypass) {
        let _ = state.close();
        return Err(e);
    }
    Ok(Box::new(state))
}

impl DarwinRoutes {
    fn apply(&mut self, device: &str, mtu: i64, bypass: &[Ipv4Net]) -> Result<(), String> {
        let mtu = mtu.to_string();
        run_command(
            IFCONFIG,
            &[
                device,
                "inet",
                "172.19.0.1",
                "172.19.0.1",
                "netmask",
                "255.255.255.252",
                "mtu",
                &mtu,
                "up",
            ],
        )?;
        run_command(
            IFCONFIG,
            &[
                device,
                "inet6",
                "fdfe:dcba:9876::1",
                "prefixlen",
                "126",
                "alias",
            ],
        )?;
        for net in bypass {
            match run_command(ROUTE, &bypass_route_args("add", net, &self.gateway)[..]) {
                Ok(_) => self.bypass.push(*net),
                Err(e) if e.contains("File exists") => {}
                Err(e) => return Err(e),
            }
        }
        for cidr in TUNNEL_IPV4_ROUTES {
            run_command(ROUTE, &["-n", "add", "-net", cidr, "172.19.0.1"])?;
            self.tunnel_cidrs.push(cidr);
        }
        run_command(
            ROUTE,
            &[
                "-n",
                "add",
                "-inet6",
                "-net",
                "2000::/3",
                "-interface",
                device,
            ],
        )?;
        self.ipv6_route = true;
        self.tailnet = keep_tailnet_on_tailscale();
        Ok(())
    }
}

/// `route` arguments that send `net` to the physical gateway.
fn bypass_route_args(action: &str, net: &Ipv4Net, gateway: &str) -> Vec<String> {
    let target = if net.prefix == 32 {
        vec!["-host".to_string(), net.addr.to_string()]
    } else {
        vec!["-net".to_string(), net.to_string()]
    };
    ["-n".to_string(), action.to_string()]
        .into_iter()
        .chain(target)
        .chain([gateway.to_string()])
        .collect()
}

/// Makes sure 100.64.0.0/10 goes to Tailscale's utun. Captive/filtered
/// networks (and stale VPN leftovers) often leave a 100.64/10 route on the
/// physical gateway, which silently black-holes every tailnet peer.
/// Best-effort: Tailscale problems must never block Aura.
fn keep_tailnet_on_tailscale() -> TailnetRoute {
    let iface = tailscale_interface();
    if iface.is_empty() {
        return TailnetRoute::default();
    }
    let (gw, current) = route_for(TAILNET);
    if current == iface {
        return TailnetRoute::default();
    }
    if current.is_empty() {
        if run_command(ROUTE, &["-n", "add", "-net", TAILNET, "-interface", &iface]).is_err() {
            return TailnetRoute::default();
        }
        return TailnetRoute {
            iface,
            added: true,
            ..Default::default()
        };
    }
    if run_command(
        ROUTE,
        &["-n", "change", "-net", TAILNET, "-interface", &iface],
    )
    .is_err()
    {
        return TailnetRoute::default();
    }
    TailnetRoute {
        iface,
        added: false,
        prev_gw: gw,
        prev_iface: current,
    }
}

/// Gateway and interface of an exact network route, or empty strings if the
/// lookup only matched a broader route.
fn route_for(cidr: &str) -> (String, String) {
    match run_command(ROUTE, &["-n", "get", "-net", cidr]) {
        Ok(output) => parse_tailnet_route(&output),
        Err(_) => (String::new(), String::new()),
    }
}

/// Reads `route -n get -net 100.64.0.0/10` output and returns its
/// gateway/interface only when the match is that exact network.
fn parse_tailnet_route(output: &str) -> (String, String) {
    let (mut dest, mut mask, mut gateway, mut iface) = ("", "", "", "");
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if let [key, value] = fields[..] {
            match key {
                "destination:" => dest = value,
                "mask:" => mask = value,
                "gateway:" => gateway = value,
                "interface:" => iface = value,
                _ => {}
            }
        }
    }
    if !matches!(dest, "100.64.0.0" | "100.64") || mask != "255.192.0.0" {
        return (String::new(), String::new());
    }
    (gateway.to_string(), iface.to_string())
}

impl TailnetRoute {
    fn restore(&mut self) -> Result<(), String> {
        if self.iface.is_empty() {
            return Ok(());
        }
        let result = if self.added {
            run_command(
                ROUTE,
                &["-n", "delete", "-net", TAILNET, "-interface", &self.iface],
            )
        } else if self.prev_gw.parse::<IpAddr>().is_ok() {
            run_command(ROUTE, &["-n", "change", "-net", TAILNET, &self.prev_gw])
        } else if !self.prev_iface.is_empty() {
            run_command(
                ROUTE,
                &[
                    "-n",
                    "change",
                    "-net",
                    TAILNET,
                    "-interface",
                    &self.prev_iface,
                ],
            )
        } else {
            Ok(String::new())
        };
        *self = TailnetRoute::default();
        result.map(drop)
    }
}

fn default_gateway() -> Result<String, String> {
    let output = run_command(ROUTE, &["-n", "get", "default"])?;
    output
        .lines()
        .filter_map(
            |line| match line.split_whitespace().collect::<Vec<_>>()[..] {
                ["gateway:", value] if value.parse::<IpAddr>().is_ok() => Some(value.to_string()),
                _ => None,
            },
        )
        .next()
        .ok_or_else(|| "could not determine the macOS default gateway".into())
}

impl RouteState for DarwinRoutes {
    fn close(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Err(e) = self.tailnet.restore() {
            errors.push(e);
        }
        if self.ipv6_route {
            if let Err(e) = run_command(ROUTE, &["-n", "delete", "-inet6", "-net", "2000::/3"]) {
                errors.push(e);
            }
            self.ipv6_route = false;
        }
        for cidr in self.tunnel_cidrs.drain(..).rev() {
            if let Err(e) = run_command(ROUTE, &["-n", "delete", "-net", cidr, "172.19.0.1"]) {
                errors.push(e);
            }
        }
        for net in self.bypass.drain(..).rev() {
            if let Err(e) =
                run_command(ROUTE, &bypass_route_args("delete", &net, &self.gateway)[..])
            {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }

    fn tailscale_state(&self) -> String {
        if !self.tailnet.iface.is_empty() {
            "rerouted".into()
        } else if !tailscale_interface().is_empty() {
            "ok".into()
        } else {
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hijacked_tailnet_route() {
        let hijacked = "   route to: 100.64.0.0
destination: 100.64.0.0
       mask: 255.192.0.0
    gateway: 10.174.128.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>";
        assert_eq!(
            parse_tailnet_route(hijacked),
            ("10.174.128.1".into(), "en0".into())
        );

        // A lookup that only matched the default route must not count as a
        // 100.64/10 route, or close would "restore" something Aura never saw.
        let broader = "   route to: 100.64.0.0
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0";
        assert_eq!(parse_tailnet_route(broader), (String::new(), String::new()));
    }
}
