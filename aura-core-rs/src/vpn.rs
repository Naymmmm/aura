use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{ready, Context, Poll};
use std::time::{Duration, SystemTime};

use ipstack::{IpStack, IpStackConfig, IpStackStream, IpStackTcpStream, TcpConfig};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, OnceCell};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;
use tun_rs::{AsyncDevice, DeviceBuilder};

use crate::config::AuraConfig;
use crate::naive::{start_naive, ManagedProcess};
use crate::proxy::MultiProxy;
use crate::routes::{
    bypass_networks, configure_routes, pin_server_ipv4, tun_device_name, RouteState,
};
use crate::udp::{PacketSink, UdpMux, UDP_IDLE_TIMEOUT};

/// Idle TCP connections are only reset after this long. SSH sessions, push
/// and mail connections can sit silent for many minutes between keepalives.
const TCP_IDLE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// Bytes the userspace stack may have in flight toward the app, and its
/// per-connection read buffer. ipstack's 16 KiB defaults cap throughput.
const TCP_WINDOW: usize = 256 * 1024;
/// Copy buffer per direction between the stack and the proxy connection.
const COPY_BUFFER: usize = 64 * 1024;

#[derive(Debug, Default, Serialize)]
pub struct RuntimeStats {
    pub running: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub active_server: String,
    pub latencies: HashMap<String, i64>,
    pub upload_total: u64,
    pub download_total: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    /// "" (not running), "ok" (coexisting) or "rerouted" (Aura pointed a
    /// hijacked 100.64/10 route back at Tailscale).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tailscale: String,
}

#[derive(Default)]
pub struct Counters {
    pub upload: AtomicU64,
    pub download: AtomicU64,
}

impl Counters {
    fn total(&self) -> u64 {
        self.upload.load(Ordering::Relaxed) + self.download.load(Ordering::Relaxed)
    }
}

pub struct VpnRuntime {
    pub started_at: SystemTime,
    naive: Arc<ManagedProcess>,
    proxy: Arc<MultiProxy>,
    counters: Arc<Counters>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    routes: Mutex<Option<Box<dyn RouteState>>>,
    closed: AtomicBool,
    stopped: OnceCell<Result<(), String>>,
    last_error: Mutex<String>,
}

pub async fn start_vpn(
    state_dir: &Path,
    naive_path: &Path,
    mut cfg: AuraConfig,
) -> Result<Arc<VpnRuntime>, String> {
    cfg.servers = pin_server_ipv4(&cfg.servers).await?;
    let (naive, endpoints) = start_naive(state_dir, naive_path, &cfg.servers)
        .await
        .map_err(|e| format!("start NaiveProxy: {e}"))?;
    let rt = Arc::new(VpnRuntime {
        started_at: SystemTime::now(),
        naive: Arc::new(naive),
        proxy: Arc::new(MultiProxy::new(endpoints)),
        counters: Arc::new(Counters::default()),
        tasks: Mutex::new(Vec::new()),
        routes: Mutex::new(None),
        closed: AtomicBool::new(false),
        stopped: OnceCell::new(),
        last_error: Mutex::new(String::new()),
    });
    if let Err(e) = rt.bring_up(&cfg).await {
        let _ = rt.stop().await;
        return Err(e);
    }
    Ok(rt)
}

impl VpnRuntime {
    async fn bring_up(self: &Arc<Self>, cfg: &AuraConfig) -> Result<(), String> {
        timeout(Duration::from_secs(10), self.proxy.probe())
            .await
            .unwrap_or_else(|_| Err("no NaiveProxy server passed its health probe".into()))?;

        // Resolve split tunneling domains while DNS still uses the real network.
        let bypass = bypass_networks(cfg).await?;
        let mtu = cfg.tun.mtu as u16;
        let device = open_tun(mtu).await.map_err(|e| format!("open TUN: {e}"))?;
        let device_name = device.name().map_err(|e| format!("open TUN: {e}"))?;
        let device = Arc::new(device);
        let stack = IpStack::new(stack_config(mtu), TunIo(device.clone()));
        let (sink, packets) = mpsc::unbounded_channel();
        let inject = tokio::spawn(inject_packets(device, packets));
        let serve = tokio::spawn(serve_stack(
            stack,
            self.proxy.clone(),
            self.counters.clone(),
            sink,
            mtu.into(),
        ));
        self.tasks.lock().unwrap().extend([serve, inject]);

        let route_mtu = cfg.tun.mtu;
        let routes =
            tokio::task::spawn_blocking(move || configure_routes(&device_name, route_mtu, &bypass))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("configure system routes: {e}"))?;
        *self.routes.lock().unwrap() = Some(routes);

        let health = tokio::spawn(self.clone().health_loop());
        self.tasks.lock().unwrap().push(health);
        // Not tracked in `tasks`: it may call stop() itself and must not be
        // aborted halfway through.
        tokio::spawn(self.clone().watch_naive());
        Ok(())
    }

    /// Keeps an eye on the tunnel as cheaply as possible: real traffic is
    /// proof of life, an idle tunnel gets a SOCKS-only check once a minute,
    /// and the full TLS probe (which also picks the fastest server) only runs
    /// when that check fails.
    async fn health_loop(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        ticker.tick().await;
        let mut last_total = 0;
        loop {
            ticker.tick().await;
            let total = self.counters.total();
            if total != last_total {
                last_total = total;
                self.set_error(None);
                continue;
            }
            let check = async {
                match self.proxy.check_active().await {
                    Ok(()) => Ok(()),
                    Err(_) => self.proxy.probe().await,
                }
            };
            let result = timeout(Duration::from_secs(8), check)
                .await
                .unwrap_or_else(|_| Err("NaiveProxy health check timed out".into()));
            self.set_error(result.err());
        }
    }

    async fn watch_naive(self: Arc<Self>) {
        self.naive.wait().await;
        if !self.closed.load(Ordering::SeqCst) {
            let reason = self
                .naive
                .err()
                .unwrap_or_else(|| "NaiveProxy exited unexpectedly".into());
            self.set_error(Some(reason));
            let _ = self.stop().await;
        }
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.stopped
            .get_or_init(|| async {
                self.closed.store(true, Ordering::SeqCst);
                let mut errors = Vec::new();
                let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
                let routes = self.routes.lock().unwrap().take();
                if let Some(mut routes) = routes {
                    match tokio::task::spawn_blocking(move || routes.close()).await {
                        Ok(Err(e)) => errors.push(e),
                        Err(e) => errors.push(e.to_string()),
                        Ok(Ok(())) => {}
                    }
                }
                // Dropping the stack closes the TUN device and every flow.
                for task in tasks {
                    task.abort();
                    let _ = task.await;
                }
                if let Err(e) = self.naive.stop().await {
                    errors.push(e);
                }
                if errors.is_empty() {
                    Ok(())
                } else {
                    Err(errors.join("\n"))
                }
            })
            .await
            .clone()
    }

    pub fn running(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.naive.running()
    }

    pub fn pid(&self) -> u32 {
        self.naive.pid()
    }

    pub fn stats(&self) -> RuntimeStats {
        let (active_server, latencies) = self.proxy.snapshot();
        let tailscale = self
            .routes
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.tailscale_state())
            .unwrap_or_default();
        RuntimeStats {
            running: self.running(),
            active_server,
            latencies,
            upload_total: self.counters.upload.load(Ordering::Relaxed),
            download_total: self.counters.download.load(Ordering::Relaxed),
            last_error: self.last_error(),
            tailscale,
        }
    }

    fn set_error(&self, err: Option<String>) {
        *self.last_error.lock().unwrap() = err.unwrap_or_default();
    }

    pub fn last_error(&self) -> String {
        self.last_error.lock().unwrap().clone()
    }
}

async fn open_tun(mtu: u16) -> io::Result<AsyncDevice> {
    // A previous session's device can take a moment to disappear after its
    // stack is dropped, and the name is fixed per platform.
    let mut attempt = 0;
    loop {
        let builder = DeviceBuilder::new()
            .name(tun_device_name())
            .mtu(mtu)
            .with(|_opt| {
                #[cfg(target_os = "macos")]
                _opt.associate_route(false);
                #[cfg(windows)]
                _opt.wintun_file(crate::routes::wintun_path());
            });
        match builder.build_async() {
            Ok(device) => return Ok(device),
            Err(e) if attempt < 10 => {
                attempt += 1;
                log::warn!("open TUN attempt {attempt} failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

fn stack_config(mtu: u16) -> IpStackConfig {
    let mut tcp = TcpConfig::default();
    tcp.timeout = TCP_IDLE_TIMEOUT;
    tcp.max_unacked_bytes = TCP_WINDOW as u32;
    tcp.read_buffer_size = TCP_WINDOW;
    let mut config = IpStackConfig::default();
    config
        .mtu_unchecked(mtu)
        .udp_timeout(UDP_IDLE_TIMEOUT)
        .with_tcp_config(tcp);
    config
}

/// Writes packets built outside the userspace stack (UDP replies) to the TUN.
async fn inject_packets(device: Arc<AsyncDevice>, mut packets: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(packet) = packets.recv().await {
        if let Err(e) = device.send(&packet).await {
            log::debug!("TUN write: {e}");
        }
    }
}

/// Adapts tun-rs's packet API to the AsyncRead/AsyncWrite device ipstack
/// expects: one read or write is exactly one IP packet.
struct TunIo(Arc<AsyncDevice>);

impl AsyncRead for TunIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let n = ready!(self.0.poll_recv(cx, buf.initialize_unfilled()))?;
        buf.advance(n);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for TunIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.0.poll_send(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Accepts flows from the userspace stack. Flow tasks live in a JoinSet so
/// aborting this task tears every one of them down with it.
async fn serve_stack(
    mut stack: IpStack,
    proxy: Arc<MultiProxy>,
    counters: Arc<Counters>,
    sink: PacketSink,
    mtu: usize,
) {
    let udp = UdpMux::new(proxy.clone(), counters.clone(), sink, mtu);
    let mut flows = JoinSet::new();
    loop {
        tokio::select! {
            accepted = stack.accept() => match accepted {
                Ok(IpStackStream::Tcp(tcp)) => {
                    flows.spawn(tcp_flow(tcp, proxy.clone(), counters.clone()));
                }
                Ok(IpStackStream::Udp(flow)) => {
                    flows.spawn(udp.clone().serve_flow(flow));
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("userspace stack stopped: {e}");
                    return;
                }
            },
            Some(_) = flows.join_next(), if !flows.is_empty() => {}
        }
    }
}

async fn tcp_flow(tcp: IpStackTcpStream, proxy: Arc<MultiProxy>, counters: Arc<Counters>) {
    let destination: SocketAddr = tcp.peer_addr();
    let remote = match proxy.dial_tcp(destination).await {
        Ok(remote) => remote,
        Err(e) => {
            log::debug!("TCP {destination}: {e}");
            return;
        }
    };
    let mut local = Counted {
        inner: tcp,
        counters: counters.clone(),
        upload: true,
    };
    let mut remote = Counted {
        inner: remote,
        counters,
        upload: false,
    };
    let _ =
        tokio::io::copy_bidirectional_with_sizes(&mut local, &mut remote, COPY_BUFFER, COPY_BUFFER)
            .await;
}

/// Counts bytes read through a stream: reads from the TUN side are uploads,
/// reads from the proxy side are downloads.
struct Counted<T> {
    inner: T,
    counters: Arc<Counters>,
    upload: bool,
}

impl<T: AsyncRead + Unpin> AsyncRead for Counted<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        ready!(Pin::new(&mut self.inner).poll_read(cx, buf))?;
        let n = (buf.filled().len() - before) as u64;
        let counter = if self.upload {
            &self.counters.upload
        } else {
            &self.counters.download
        };
        counter.fetch_add(n, Ordering::Relaxed);
        Poll::Ready(Ok(()))
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Counted<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{
        encode_uot_packet, read_uot_packet, ProxyEndpoint, SocksAddr, UOT_MAGIC_ADDRESS,
    };
    use etherparse::{PacketBuilder, SlicedPacket, TransportSlice};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// An in-memory TUN: packets in through one channel, out through another.
    struct ChannelDevice {
        inbound: mpsc::UnboundedReceiver<Vec<u8>>,
        outbound: mpsc::UnboundedSender<Vec<u8>>,
    }

    impl AsyncRead for ChannelDevice {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(packet) = ready!(self.inbound.poll_recv(cx)) {
                buf.put_slice(&packet);
            }
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for ChannelDevice {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            let _ = self.outbound.send(buf.to_vec());
            Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn udp_packet(from: ([u8; 4], u16), to: ([u8; 4], u16), payload: &[u8]) -> Vec<u8> {
        let mut packet = Vec::new();
        PacketBuilder::ipv4(from.0, to.0, 64)
            .udp(from.1, to.1)
            .write(&mut packet, payload)
            .unwrap();
        packet
    }

    async fn next_udp(
        rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    ) -> (SocketAddr, SocketAddr, Vec<u8>) {
        let packet = timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let sliced = SlicedPacket::from_ip(&packet).unwrap();
        let Some(etherparse::NetSlice::Ipv4(ip)) = sliced.net else {
            panic!("not IPv4")
        };
        let Some(TransportSlice::Udp(udp)) = sliced.transport else {
            panic!("not UDP")
        };
        let h = ip.header();
        (
            SocketAddr::from((h.source(), udp.source_port())),
            SocketAddr::from((h.destination(), udp.destination_port())),
            udp.payload().to_vec(),
        )
    }

    #[tokio::test]
    async fn udp_socket_shares_one_uot_stream_across_peers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await?;
            let mut greeting = [0u8; 3];
            conn.read_exact(&mut greeting).await?;
            conn.write_all(&[5, 0]).await?;
            let mut request = [0u8; 3];
            conn.read_exact(&mut request).await?;
            assert_eq!(
                SocksAddr::read(&mut conn).await?,
                SocksAddr::Domain(UOT_MAGIC_ADDRESS.into(), 0)
            );
            conn.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            assert_eq!(conn.read_u8().await?, 0, "non-connected mode");
            SocksAddr::read(&mut conn).await?;
            let mut buf = [0u8; 64];
            let mut frame = Vec::new();
            // DNS query and its answer.
            let (peer, n) = read_uot_packet(&mut conn, &mut buf).await?;
            assert_eq!(
                (peer, &buf[..n]),
                (Some("8.8.8.8:53".parse().unwrap()), &b"ping"[..])
            );
            encode_uot_packet(peer.unwrap(), b"pong!", &mut frame)?;
            conn.write_all(&frame).await?;
            // A second peer on the same socket arrives on the same stream...
            let (peer, n) = read_uot_packet(&mut conn, &mut buf).await?;
            assert_eq!(
                (peer, &buf[..n]),
                (Some("9.9.9.9:3478".parse().unwrap()), &b"stun"[..])
            );
            // ...and a peer the app never sent to can still reach it.
            encode_uot_packet("1.2.3.4:5000".parse().unwrap(), b"hello", &mut frame)?;
            conn.write_all(&frame).await?;
            let second = timeout(Duration::from_millis(300), listener.accept()).await;
            assert!(second.is_err(), "one local socket must use one UoT stream");
            let _ = conn.read_u8().await;
            Ok::<_, io::Error>(())
        });

        let (to_stack, inbound) = mpsc::unbounded_channel();
        let (outbound, mut from_stack) = mpsc::unbounded_channel();
        let stack = IpStack::new(
            stack_config(1400),
            ChannelDevice {
                inbound,
                outbound: outbound.clone(),
            },
        );
        let proxy = Arc::new(MultiProxy::new(vec![ProxyEndpoint {
            tag: "t".into(),
            addr,
        }]));
        let counters = Arc::new(Counters::default());
        let serve = tokio::spawn(serve_stack(stack, proxy, counters.clone(), outbound, 1400));

        let app: SocketAddr = "10.0.0.2:5000".parse().unwrap();
        to_stack
            .send(udp_packet(
                ([10, 0, 0, 2], 5000),
                ([8, 8, 8, 8], 53),
                b"ping",
            ))
            .unwrap();
        assert_eq!(
            next_udp(&mut from_stack).await,
            ("8.8.8.8:53".parse().unwrap(), app, b"pong!".to_vec())
        );
        to_stack
            .send(udp_packet(
                ([10, 0, 0, 2], 5000),
                ([9, 9, 9, 9], 3478),
                b"stun",
            ))
            .unwrap();
        assert_eq!(
            next_udp(&mut from_stack).await,
            ("1.2.3.4:5000".parse().unwrap(), app, b"hello".to_vec())
        );
        assert_eq!(counters.upload.load(Ordering::Relaxed), 8);
        assert_eq!(counters.download.load(Ordering::Relaxed), 10);

        serve.abort();
        let _ = serve.await;
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn udp_session_reopens_after_the_stream_drops() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let mut payloads = Vec::new();
            for _ in 0..2 {
                let (mut conn, _) = listener.accept().await?;
                let mut head = [0u8; 3];
                conn.read_exact(&mut head).await?;
                conn.write_all(&[5, 0]).await?;
                conn.read_exact(&mut head).await?;
                SocksAddr::read(&mut conn).await?;
                conn.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                conn.read_u8().await?;
                SocksAddr::read(&mut conn).await?;
                let mut buf = [0u8; 16];
                let (_, n) = read_uot_packet(&mut conn, &mut buf).await?;
                payloads.push(buf[..n].to_vec());
                // Dropping `conn` closes the stream, as a server restart would.
            }
            Ok::<_, io::Error>(payloads)
        });

        let proxy = Arc::new(MultiProxy::new(vec![ProxyEndpoint {
            tag: "t".into(),
            addr,
        }]));
        let (sink, _packets) = mpsc::unbounded_channel();
        let mux = UdpMux::new(proxy, Arc::new(Counters::default()), sink, 1400);
        let (app, peer) = (
            "10.0.0.2:5000".parse().unwrap(),
            "8.8.8.8:53".parse().unwrap(),
        );
        mux.send(app, peer, b"one").await.unwrap();
        // Wait for the reader to notice the closed stream and retire it.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while mux.session_count() > 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "session was not retired"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        mux.send(app, peer, b"two").await.unwrap();
        let payloads = timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(payloads, vec![b"one".to_vec(), b"two".to_vec()]);
    }

    #[test]
    fn tcp_tuning_replaces_ipstack_defaults() {
        let config = stack_config(1400);
        assert_eq!(config.tcp_config.timeout, TCP_IDLE_TIMEOUT);
        assert_eq!(config.tcp_config.max_unacked_bytes as usize, TCP_WINDOW);
        assert_eq!(config.udp_timeout, UDP_IDLE_TIMEOUT);
    }

    #[tokio::test]
    async fn tcp_stream_flows_through_socks() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await?;
            let mut greeting = [0u8; 3];
            conn.read_exact(&mut greeting).await?;
            conn.write_all(&[5, 0]).await?;
            let mut request = [0u8; 3];
            conn.read_exact(&mut request).await?;
            assert_eq!(
                SocksAddr::read(&mut conn).await?,
                SocksAddr::Ip("1.2.3.4:80".parse().unwrap())
            );
            conn.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let mut hello = [0u8; 5];
            conn.read_exact(&mut hello).await?;
            assert_eq!(&hello, b"hello");
            conn.write_all(b"world").await?;
            let _ = conn.read_u8().await;
            Ok::<_, io::Error>(())
        });

        let (to_stack, inbound) = mpsc::unbounded_channel();
        let (outbound, mut from_stack) = mpsc::unbounded_channel();
        let stack = IpStack::new(
            stack_config(1400),
            ChannelDevice {
                inbound,
                outbound: outbound.clone(),
            },
        );
        let proxy = Arc::new(MultiProxy::new(vec![ProxyEndpoint {
            tag: "t".into(),
            addr,
        }]));
        let counters = Arc::new(Counters::default());
        let serve = tokio::spawn(serve_stack(stack, proxy, counters.clone(), outbound, 1400));

        let client = |seq: u32| {
            PacketBuilder::ipv4([10, 0, 0, 2], [1, 2, 3, 4], 64).tcp(40000, 80, seq, 65535)
        };
        let mut syn = Vec::new();
        client(1000).syn().write(&mut syn, &[]).unwrap();
        to_stack.send(syn).unwrap();

        let mut server_seq = None;
        let mut received = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while received != b"world" {
            let packet = tokio::time::timeout_at(deadline, from_stack.recv())
                .await
                .expect("timed out")
                .unwrap();
            let sliced = SlicedPacket::from_ip(&packet).unwrap();
            let Some(TransportSlice::Tcp(tcp)) = sliced.transport else {
                continue;
            };
            if tcp.syn() && tcp.ack() && server_seq.is_none() {
                let seq = tcp.sequence_number().wrapping_add(1);
                server_seq = Some(seq);
                let mut ack = Vec::new();
                client(1001).ack(seq).write(&mut ack, &[]).unwrap();
                to_stack.send(ack).unwrap();
                let mut data = Vec::new();
                client(1001)
                    .ack(seq)
                    .psh()
                    .write(&mut data, b"hello")
                    .unwrap();
                to_stack.send(data).unwrap();
            } else if !tcp.payload().is_empty() {
                received.extend_from_slice(tcp.payload());
            }
        }
        assert_eq!(counters.upload.load(Ordering::Relaxed), 5);
        assert_eq!(counters.download.load(Ordering::Relaxed), 5);

        serve.abort();
        let _ = serve.await;
        server.await.unwrap().unwrap();
    }
}
