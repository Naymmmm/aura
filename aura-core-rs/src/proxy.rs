use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

pub const UOT_MAGIC_ADDRESS: &str = "sp.v2.udp-over-tcp.arpa";
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TARGET: ([u8; 4], u16) = ([1, 1, 1, 1], 443);

#[derive(Debug, Clone)]
pub struct ProxyEndpoint {
    pub tag: String,
    pub addr: String,
}

/// A SOCKS5 destination address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocksAddr {
    Ip(SocketAddr),
    Domain(String, u16),
}

impl SocksAddr {
    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            SocksAddr::Ip(SocketAddr::V4(a)) => {
                out.push(1);
                out.extend_from_slice(&a.ip().octets());
                out.extend_from_slice(&a.port().to_be_bytes());
            }
            SocksAddr::Ip(SocketAddr::V6(a)) => {
                out.push(4);
                out.extend_from_slice(&a.ip().octets());
                out.extend_from_slice(&a.port().to_be_bytes());
            }
            SocksAddr::Domain(host, port) => {
                out.push(3);
                out.push(host.len() as u8);
                out.extend_from_slice(host.as_bytes());
                out.extend_from_slice(&port.to_be_bytes());
            }
        }
    }

    pub async fn read<R: AsyncReadExt + Unpin>(r: &mut R) -> io::Result<SocksAddr> {
        match r.read_u8().await? {
            1 => {
                let mut ip = [0u8; 4];
                r.read_exact(&mut ip).await?;
                Ok(SocksAddr::Ip(SocketAddr::new(
                    IpAddr::from(ip),
                    r.read_u16().await?,
                )))
            }
            4 => {
                let mut ip = [0u8; 16];
                r.read_exact(&mut ip).await?;
                Ok(SocksAddr::Ip(SocketAddr::new(
                    IpAddr::from(ip),
                    r.read_u16().await?,
                )))
            }
            3 => {
                let len = r.read_u8().await? as usize;
                let mut host = vec![0u8; len];
                r.read_exact(&mut host).await?;
                let host = String::from_utf8(host).map_err(|_| invalid("invalid SOCKS domain"))?;
                Ok(SocksAddr::Domain(host, r.read_u16().await?))
            }
            _ => Err(invalid("invalid SOCKS address type")),
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Opens a SOCKS5 CONNECT tunnel through NaiveProxy's local listener.
pub async fn dial_socks(endpoint: &str, target: &SocksAddr) -> io::Result<TcpStream> {
    let attempt = async {
        let mut conn = TcpStream::connect(endpoint).await?;
        conn.set_nodelay(true)?;
        conn.write_all(&[5, 1, 0]).await?;
        let mut reply = [0u8; 2];
        conn.read_exact(&mut reply).await?;
        if reply != [5, 0] {
            return Err(invalid("SOCKS server rejected the no-auth method"));
        }
        let mut request = vec![5, 1, 0];
        target.encode(&mut request);
        conn.write_all(&request).await?;
        let mut head = [0u8; 3];
        conn.read_exact(&mut head).await?;
        if head[0] != 5 || head[1] != 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("SOCKS CONNECT failed with code {}", head[1]),
            ));
        }
        SocksAddr::read(&mut conn).await?;
        Ok(conn)
    };
    timeout(DIAL_TIMEOUT, attempt)
        .await
        .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
}

struct ProxyState {
    active: Option<usize>,
    latencies: HashMap<String, i64>,
}

/// Fails over between NaiveProxy transports, preferring whichever one last
/// worked and then the lowest probe latency.
pub struct MultiProxy {
    endpoints: Vec<ProxyEndpoint>,
    state: RwLock<ProxyState>,
}

impl MultiProxy {
    pub fn new(endpoints: Vec<ProxyEndpoint>) -> MultiProxy {
        MultiProxy {
            endpoints,
            state: RwLock::new(ProxyState {
                active: None,
                latencies: HashMap::new(),
            }),
        }
    }

    pub async fn dial_tcp(&self, destination: SocketAddr) -> io::Result<TcpStream> {
        let target = SocksAddr::Ip(destination);
        let mut last_err = None;
        for index in self.order() {
            match dial_socks(&self.endpoints[index].addr, &target).await {
                Ok(conn) => {
                    self.set_active(index);
                    return Ok(conn);
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(all_failed("all NaiveProxy transports failed", last_err))
    }

    /// Opens a UoT v2 stream in non-connected mode: SOCKS CONNECT to the
    /// magic address, then the request (mode byte 0 and a SOCKS address, which
    /// the server ignores in this mode). Every packet then names its own peer.
    pub async fn dial_uot(&self, first: SocketAddr) -> io::Result<TcpStream> {
        let magic = SocksAddr::Domain(UOT_MAGIC_ADDRESS.into(), 0);
        let mut header = vec![0];
        SocksAddr::Ip(first).encode(&mut header);
        let mut last_err = None;
        for index in self.order() {
            let attempt = async {
                let mut conn = dial_socks(&self.endpoints[index].addr, &magic).await?;
                conn.write_all(&header).await?;
                Ok::<_, io::Error>(conn)
            };
            match attempt.await {
                Ok(conn) => {
                    self.set_active(index);
                    return Ok(conn);
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(all_failed("all NaiveProxy UoT transports failed", last_err))
    }

    /// Times a SOCKS CONNECT plus TLS handshake through every transport and
    /// makes the fastest one active.
    pub async fn probe(&self) -> Result<(), String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        for (index, endpoint) in self.endpoints.iter().enumerate() {
            let tx = tx.clone();
            let addr = endpoint.addr.clone();
            tokio::spawn(async move {
                let started = Instant::now();
                if tls_probe(&addr).await.is_ok() {
                    let _ = tx.send((index, (started.elapsed().as_millis() as i64).max(1)));
                }
            });
        }
        drop(tx);
        let mut latencies = HashMap::new();
        let mut best: Option<(usize, i64)> = None;
        while let Some((index, ms)) = rx.recv().await {
            latencies.insert(self.endpoints[index].tag.clone(), ms);
            if best.is_none_or(|(_, b)| ms < b) {
                best = Some((index, ms));
            }
        }
        let Some((index, _)) = best else {
            return Err("no NaiveProxy server passed its health probe".into());
        };
        let mut state = self.state.write().unwrap();
        state.active = Some(index);
        state.latencies = latencies;
        Ok(())
    }

    /// The cheap liveness check: a SOCKS CONNECT through the active transport
    /// proves NaiveProxy and the server are up without a TLS handshake.
    pub async fn check_active(&self) -> Result<(), String> {
        let active = self.state.read().unwrap().active;
        let Some(index) = active else {
            return Err("no active NaiveProxy transport".into());
        };
        let target = SocksAddr::Ip(PROBE_TARGET.into());
        dial_socks(&self.endpoints[index].addr, &target)
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    }

    pub fn snapshot(&self) -> (String, HashMap<String, i64>) {
        let state = self.state.read().unwrap();
        let active = state
            .active
            .map(|i| self.endpoints[i].tag.clone())
            .unwrap_or_default();
        (active, state.latencies.clone())
    }

    fn order(&self) -> Vec<usize> {
        let state = self.state.read().unwrap();
        let mut rest: Vec<usize> = (0..self.endpoints.len())
            .filter(|&i| Some(i) != state.active)
            .collect();
        // Unprobed transports sort first, matching the Go supervisor's zero default.
        rest.sort_by_key(|&i| {
            state
                .latencies
                .get(&self.endpoints[i].tag)
                .copied()
                .unwrap_or(0)
        });
        state.active.into_iter().chain(rest).collect()
    }

    fn set_active(&self, index: usize) {
        self.state.write().unwrap().active = Some(index);
    }
}

fn all_failed(context: &str, last: Option<io::Error>) -> io::Error {
    let detail = last
        .map(|e| e.to_string())
        .unwrap_or_else(|| "no transports".into());
    io::Error::other(format!("{context}: {detail}"))
}

async fn tls_probe(endpoint: &str) -> io::Result<()> {
    static CONNECTOR: OnceLock<TlsConnector> = OnceLock::new();
    let connector = CONNECTOR.get_or_init(|| {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports TLS 1.2 and 1.3")
            .with_root_certificates(roots)
            .with_no_client_auth();
        TlsConnector::from(Arc::new(config))
    });
    let attempt = async {
        let conn = dial_socks(endpoint, &SocksAddr::Ip(PROBE_TARGET.into())).await?;
        let name = ServerName::try_from("cloudflare-dns.com").expect("static server name");
        let mut tls = connector.connect(name, conn).await?;
        let _ = tls.shutdown().await;
        Ok(())
    };
    timeout(Duration::from_secs(10), attempt)
        .await
        .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
}

// UoT v2 packet addresses use sing's own family bytes, not SOCKS ones.
const UOT_IPV4: u8 = 0x00;
const UOT_IPV6: u8 = 0x01;
const UOT_FQDN: u8 = 0x02;

/// Encodes one non-connected UoT v2 packet: peer address, port, big-endian
/// u16 length, payload.
pub fn encode_uot_packet(peer: SocketAddr, payload: &[u8], out: &mut Vec<u8>) -> io::Result<()> {
    let length =
        u16::try_from(payload.len()).map_err(|_| invalid("UoT datagram exceeds 65535 bytes"))?;
    out.clear();
    match peer.ip() {
        IpAddr::V4(ip) => {
            out.push(UOT_IPV4);
            out.extend_from_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            out.push(UOT_IPV6);
            out.extend_from_slice(&ip.octets());
        }
    }
    out.extend_from_slice(&peer.port().to_be_bytes());
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(())
}

/// Reads one non-connected UoT v2 packet into `buf`. The peer is None for a
/// domain-addressed packet, which is consumed and skipped.
pub async fn read_uot_packet<R: AsyncReadExt + Unpin>(
    r: &mut R,
    buf: &mut [u8],
) -> io::Result<(Option<SocketAddr>, usize)> {
    let ip = match r.read_u8().await? {
        UOT_IPV4 => {
            let mut ip = [0u8; 4];
            r.read_exact(&mut ip).await?;
            Some(IpAddr::from(ip))
        }
        UOT_IPV6 => {
            let mut ip = [0u8; 16];
            r.read_exact(&mut ip).await?;
            Some(IpAddr::from(ip))
        }
        UOT_FQDN => {
            let mut name = vec![0u8; r.read_u8().await? as usize];
            r.read_exact(&mut name).await?;
            None
        }
        _ => return Err(invalid("invalid UoT address family")),
    };
    let port = r.read_u16().await?;
    let length = r.read_u16().await? as usize;
    if length > buf.len() {
        return Err(invalid("UoT datagram exceeds the buffer"));
    }
    r.read_exact(&mut buf[..length]).await?;
    Ok((ip.map(|ip| SocketAddr::new(ip, port)), length))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn quic_datagrams_through_non_connected_uot_v2() {
        // Chromium QUIC initial packets are close to the path MTU. Keep this
        // payload large enough to catch Naive padding/framing corruption.
        let expected = vec![0x42u8; 1350];
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server_payload = expected.clone();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await?;
            let mut greeting = [0u8; 3];
            conn.read_exact(&mut greeting).await?;
            conn.write_all(&[5, 0]).await?;
            let mut request = [0u8; 3];
            conn.read_exact(&mut request).await?;
            let address = SocksAddr::read(&mut conn).await?;
            assert_eq!(request, [5, 1, 0]);
            assert_eq!(address, SocksAddr::Domain(UOT_MAGIC_ADDRESS.into(), 0));
            conn.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
            assert_eq!(conn.read_u8().await?, 0, "UoT must use non-connected mode");
            SocksAddr::read(&mut conn).await?;
            // Two peers on one stream; each packet carries its own address.
            let mut buf = vec![0u8; 65535];
            for peer in ["8.8.8.8:443", "[2001:db8::1]:3478"] {
                let (from, n) = read_uot_packet(&mut conn, &mut buf).await?;
                assert_eq!(from, Some(peer.parse().unwrap()));
                assert_eq!(&buf[..n], &server_payload[..]);
                let mut frame = Vec::new();
                encode_uot_packet(from.unwrap(), &buf[..n], &mut frame)?;
                conn.write_all(&frame).await?;
            }
            Ok::<_, io::Error>(())
        });

        let proxy = MultiProxy::new(vec![ProxyEndpoint {
            tag: "test".into(),
            addr,
        }]);
        let mut conn = proxy
            .dial_uot("8.8.8.8:443".parse().unwrap())
            .await
            .unwrap();
        let mut buf = vec![0u8; 65535];
        for peer in ["8.8.8.8:443", "[2001:db8::1]:3478"] {
            let peer: SocketAddr = peer.parse().unwrap();
            let mut frame = Vec::new();
            encode_uot_packet(peer, &expected, &mut frame).unwrap();
            conn.write_all(&frame).await.unwrap();
            let (from, n) = timeout(Duration::from_secs(2), read_uot_packet(&mut conn, &mut buf))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(from, Some(peer));
            assert_eq!(&buf[..n], &expected[..]);
        }
        server.await.unwrap().unwrap();
        assert_eq!(proxy.snapshot().0, "test");
    }

    #[tokio::test]
    async fn skips_domain_addressed_packets() {
        let mut wire: &[u8] = &[UOT_FQDN, 3, b'a', b'.', b'b', 0, 53, 0, 2, 9, 9];
        let mut buf = [0u8; 8];
        assert_eq!(
            read_uot_packet(&mut wire, &mut buf).await.unwrap(),
            (None, 2)
        );
    }

    #[test]
    fn order_prefers_active_then_latency() {
        let endpoints = ["a", "b", "c"]
            .map(|t| ProxyEndpoint {
                tag: t.into(),
                addr: String::new(),
            })
            .to_vec();
        let proxy = MultiProxy::new(endpoints);
        {
            let mut state = proxy.state.write().unwrap();
            state.active = Some(1);
            state.latencies = HashMap::from([("a".into(), 90), ("b".into(), 50), ("c".into(), 20)]);
        }
        assert_eq!(proxy.order(), vec![1, 2, 0]);
    }
}
