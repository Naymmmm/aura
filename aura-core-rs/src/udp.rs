//! UDP over UoT v2 in non-connected mode.
//!
//! Every local UDP socket (source address + port) gets one UoT stream, and
//! each packet on it carries its own destination. The server keeps a single
//! UDP socket per stream, so a local socket keeps the same public mapping for
//! every peer it talks to (what STUN, WebRTC, games and Tailscale need), and
//! one QUIC or game socket costs one stream instead of one per destination.
//!
//! Replies are written straight to the TUN device rather than through the
//! userspace stack, so packets from peers the app never sent to still arrive.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use etherparse::PacketBuilder;
use ipstack::IpStackUdpStream;
use tokio::io::AsyncReadExt;
use tokio::net::tcp::OwnedReadHalf;
use tokio::sync::{mpsc, OnceCell};
use tokio::task::JoinHandle;

use crate::proxy::{encode_uot_packet, read_uot_packet, MultiProxy};
use crate::vpn::Counters;

/// A session with no traffic either way for this long is closed.
pub const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Packets queued for one stream before new ones are dropped, as UDP would.
const SEND_QUEUE: usize = 512;
const MAX_DATAGRAM: usize = 65535;

/// Raw IP packets bound for the TUN device.
pub type PacketSink = mpsc::UnboundedSender<Vec<u8>>;

type Slot = Arc<OnceCell<Arc<Session>>>;

pub struct UdpMux {
    proxy: Arc<MultiProxy>,
    counters: Arc<Counters>,
    sink: PacketSink,
    mtu: usize,
    epoch: Instant,
    sessions: Mutex<HashMap<SocketAddr, Slot>>,
}

struct Session {
    queue: mpsc::Sender<Vec<u8>>,
    last_active: Arc<AtomicU64>,
    /// Writer and reader; dropping the session stops both.
    _tasks: [AbortOnDrop; 2],
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl UdpMux {
    pub fn new(
        proxy: Arc<MultiProxy>,
        counters: Arc<Counters>,
        sink: PacketSink,
        mtu: usize,
    ) -> Arc<UdpMux> {
        Arc::new(UdpMux {
            proxy,
            counters,
            sink,
            mtu,
            epoch: Instant::now(),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    /// Forwards every datagram the app sends on one flow of the userspace
    /// stack. The flow ends when the stack times it out; its session lives
    /// on for as long as either side keeps talking.
    pub async fn serve_flow(self: Arc<Self>, mut flow: IpStackUdpStream) {
        let local = flow.local_addr();
        let remote = flow.peer_addr();
        let mut buf = vec![0u8; MAX_DATAGRAM];
        loop {
            let n = match flow.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            if let Err(e) = self.send(local, remote, &buf[..n]).await {
                log::debug!("UDP {local} -> {remote}: {e}");
            }
        }
    }

    pub(crate) async fn send(
        self: &Arc<Self>,
        local: SocketAddr,
        remote: SocketAddr,
        payload: &[u8],
    ) -> io::Result<()> {
        let session = self.session(local, remote).await?;
        let mut frame = Vec::with_capacity(payload.len() + 21);
        encode_uot_packet(remote, payload, &mut frame)?;
        session.last_active.store(self.now(), Ordering::Relaxed);
        if session.queue.try_send(frame).is_ok() {
            self.counters
                .upload
                .fetch_add(payload.len() as u64, Ordering::Relaxed);
        }
        Ok(())
    }

    async fn session(
        self: &Arc<Self>,
        local: SocketAddr,
        first: SocketAddr,
    ) -> io::Result<Arc<Session>> {
        let slot = self
            .sessions
            .lock()
            .unwrap()
            .entry(local)
            .or_default()
            .clone();
        let result = slot
            .get_or_try_init(|| self.open(local, first))
            .await
            .cloned();
        if result.is_err() {
            self.forget(local, &slot);
        }
        result
    }

    async fn open(
        self: &Arc<Self>,
        local: SocketAddr,
        first: SocketAddr,
    ) -> io::Result<Arc<Session>> {
        let stream = self.proxy.dial_uot(first).await?;
        let (read, mut write) = stream.into_split();
        let (queue, mut frames) = mpsc::channel::<Vec<u8>>(SEND_QUEUE);
        let last_active = Arc::new(AtomicU64::new(self.now()));
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(frame) = frames.recv().await {
                if write.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        let reader = tokio::spawn(Self::read_replies(
            Arc::downgrade(self),
            local,
            read,
            last_active.clone(),
        ));
        Ok(Arc::new(Session {
            queue,
            last_active,
            _tasks: [AbortOnDrop(writer), AbortOnDrop(reader)],
        }))
    }

    /// Delivers the server's replies to the app until the stream fails or the
    /// session goes idle, then retires the session.
    async fn read_replies(
        mux: Weak<UdpMux>,
        local: SocketAddr,
        mut read: OwnedReadHalf,
        last_active: Arc<AtomicU64>,
    ) {
        let mut buf = vec![0u8; MAX_DATAGRAM];
        loop {
            let reply =
                tokio::time::timeout(UDP_IDLE_TIMEOUT, read_uot_packet(&mut read, &mut buf)).await;
            let Some(mux) = mux.upgrade() else { return };
            match reply {
                Ok(Ok((Some(remote), n))) => {
                    last_active.store(mux.now(), Ordering::Relaxed);
                    mux.deliver(remote, local, &buf[..n]);
                }
                // A domain-addressed reply has no IP to answer from.
                Ok(Ok((None, _))) => {}
                Ok(Err(_)) => return mux.retire(local),
                Err(_) => {
                    let idle = mux
                        .now()
                        .saturating_sub(last_active.load(Ordering::Relaxed));
                    if idle >= UDP_IDLE_TIMEOUT.as_millis() as u64 {
                        return mux.retire(local);
                    }
                }
            }
        }
    }

    fn deliver(&self, remote: SocketAddr, local: SocketAddr, payload: &[u8]) {
        match build_udp_packet(remote, local, payload, self.mtu) {
            Some(packet) => {
                self.counters
                    .download
                    .fetch_add(payload.len() as u64, Ordering::Relaxed);
                let _ = self.sink.send(packet);
            }
            None => log::debug!(
                "UDP {remote} -> {local}: dropped {}-byte reply",
                payload.len()
            ),
        }
    }

    fn retire(&self, local: SocketAddr) {
        // Drop the session outside the lock: dropping it aborts its tasks.
        let _session = self.sessions.lock().unwrap().remove(&local);
    }

    fn forget(&self, local: SocketAddr, slot: &Slot) {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.get(&local).is_some_and(|s| Arc::ptr_eq(s, slot)) {
            sessions.remove(&local);
        }
    }

    fn now(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    #[cfg(test)]
    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

/// Builds the IP+UDP packet that delivers `payload` from `remote` to the
/// app's `local` socket, or None when it can't fit the TUN MTU or the
/// address families don't match.
pub fn build_udp_packet(
    remote: SocketAddr,
    local: SocketAddr,
    payload: &[u8],
    mtu: usize,
) -> Option<Vec<u8>> {
    let remote_ip = match (remote.ip(), local.ip()) {
        (IpAddr::V6(v6), IpAddr::V4(_)) => IpAddr::V4(v6.to_ipv4_mapped()?),
        (ip, _) => ip,
    };
    let builder = match (remote_ip, local.ip()) {
        (IpAddr::V4(src), IpAddr::V4(dst)) => PacketBuilder::ipv4(src.octets(), dst.octets(), 64),
        (IpAddr::V6(src), IpAddr::V6(dst)) => PacketBuilder::ipv6(src.octets(), dst.octets(), 64),
        _ => return None,
    }
    .udp(remote.port(), local.port());
    if builder.size(payload.len()) > mtu {
        return None;
    }
    let mut packet = Vec::with_capacity(builder.size(payload.len()));
    builder.write(&mut packet, payload).ok()?;
    Some(packet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use etherparse::{SlicedPacket, TransportSlice};

    #[test]
    fn builds_reply_packets_and_respects_mtu() {
        let packet = build_udp_packet(
            "8.8.8.8:53".parse().unwrap(),
            "172.19.0.1:5000".parse().unwrap(),
            b"hi",
            1400,
        )
        .unwrap();
        let sliced = SlicedPacket::from_ip(&packet).unwrap();
        let Some(TransportSlice::Udp(udp)) = sliced.transport else {
            panic!("not UDP")
        };
        assert_eq!(
            (udp.source_port(), udp.destination_port(), udp.payload()),
            (53, 5000, &b"hi"[..])
        );

        // IPv4-mapped replies to an IPv4 socket are answered over IPv4.
        assert!(build_udp_packet(
            "[::ffff:8.8.8.8]:53".parse().unwrap(),
            "172.19.0.1:5000".parse().unwrap(),
            b"x",
            1400
        )
        .is_some());
        assert!(build_udp_packet(
            "[2001:db8::1]:53".parse().unwrap(),
            "172.19.0.1:5000".parse().unwrap(),
            b"x",
            1400
        )
        .is_none());
        assert!(build_udp_packet(
            "8.8.8.8:53".parse().unwrap(),
            "172.19.0.1:5000".parse().unwrap(),
            &[0; 1400],
            1400
        )
        .is_none());
    }

    /// Runs against a real sing UoT server: AURA_UOT_REFERENCE=socks,echoA,echoB.
    #[tokio::test]
    #[ignore]
    async fn interoperates_with_sing_reference_server() {
        let reference = std::env::var("AURA_UOT_REFERENCE").expect("AURA_UOT_REFERENCE");
        let parts: Vec<&str> = reference.trim().split(',').collect();
        let (socks, peers) = (
            parts[0],
            [
                parts[1].parse::<SocketAddr>().unwrap(),
                parts[2].parse().unwrap(),
            ],
        );
        let proxy = Arc::new(MultiProxy::new(vec![crate::proxy::ProxyEndpoint {
            tag: "ref".into(),
            addr: socks.into(),
        }]));
        let (sink, mut packets) = mpsc::unbounded_channel();
        let mux = UdpMux::new(proxy, Arc::new(Counters::default()), sink, 1400);
        let app: SocketAddr = "10.0.0.2:5000".parse().unwrap();
        let mut seen = Vec::new();
        for (peer, tag) in peers.iter().zip(["a", "b"]) {
            mux.send(app, *peer, tag.as_bytes()).await.unwrap();
            let packet = tokio::time::timeout(Duration::from_secs(3), packets.recv())
                .await
                .unwrap()
                .unwrap();
            let sliced = SlicedPacket::from_ip(&packet).unwrap();
            let Some(TransportSlice::Udp(udp)) = sliced.transport else {
                panic!("not UDP")
            };
            assert_eq!(udp.source_port(), peer.port());
            assert_eq!(udp.destination_port(), 5000);
            let reply = String::from_utf8(udp.payload().to_vec()).unwrap();
            let (echoed, observed) = reply.split_once('|').unwrap();
            assert_eq!(echoed, tag);
            seen.push(observed.to_string());
        }
        assert_eq!(mux.session_count(), 1);
        assert_eq!(
            seen[0], seen[1],
            "both peers must see the same source mapping"
        );
    }
}
