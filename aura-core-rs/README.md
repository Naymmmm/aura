# aura-core (Rust)

A Rust port of [`aura-core`](../aura-core), Aura's privileged tunnel
supervisor. It is a drop-in replacement for the Go binary: same `serve` flags,
the same authenticated API on `127.0.0.1:45873` (`/v1/status`, `/v1/stats`,
`/v1/start`, `/v1/stop`, `/v1/log`), the same config schema and state-dir
files, and the same route handling on macOS, Windows and Linux.

| Go                          | Rust                                      |
|-----------------------------|-------------------------------------------|
| tun2socks + gVisor netstack | `tun-rs` + `ipstack` (pure Rust)          |
| `net/http`                  | `axum` / `hyper`                          |
| `crypto/tls` probe          | `rustls` (ring) + Mozilla roots           |

TCP still goes through NaiveProxy's local SOCKS endpoints, and UDP is still
framed by Aura Core as UoT v2 over the same transport, so the wire protocol
is unchanged.

## Development

```sh
cargo test
cargo clippy --all-targets
cargo build --release   # target/release/aura-core
```

The tests include in-memory TUN round trips: TCP and UDP packets go through
the userspace stack, SOCKS, UoT and back. Opening the real TUN device and
changing routes requires root (or SYSTEM on Windows), so test that part
against a live server.
