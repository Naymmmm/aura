use std::net::IpAddr;

/// Tailscale hands out addresses from the CGNAT range (100.64.0.0/10) and a
/// fixed IPv6 ULA (fd7a:115c:a1e0::/48). Aura never tunnels these: tailnet
/// traffic must stay on Tailscale's own interface or peers, MagicDNS
/// (100.100.100.100) and subnet routes break.
pub fn is_tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// Returns the name of the interface Tailscale is running on (utunN on macOS,
/// tailscale0 on Linux, "Tailscale" on Windows), or "" if Tailscale isn't up.
/// Detection is by address, so it works for the App Store, standalone and
/// open-source builds alike.
pub fn tailscale_interface() -> String {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return String::new();
    };
    interfaces
        .into_iter()
        // Carrier-grade NAT ISPs hand 100.64/10 addresses to real Wi-Fi and
        // Ethernet too, but Tailscale is always a point-to-point TUN.
        .find(|i| i.is_oper_up() && (i.is_p2p() || cfg!(windows)) && is_tailnet(i.ip()))
        .map(|i| i.name)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_tailnet_ranges() {
        for ip in [
            "100.64.0.1",
            "100.127.255.254",
            "100.100.100.100",
            "fd7a:115c:a1e0::1",
        ] {
            assert!(is_tailnet(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "100.63.255.255",
            "100.128.0.0",
            "10.0.0.1",
            "fd7a:115c:a1e1::1",
        ] {
            assert!(!is_tailnet(ip.parse().unwrap()), "{ip}");
        }
    }
}
