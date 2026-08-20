# Aura 🏆

DPI-resistant VPN on Oracle Cloud Always Free + a Flutter desktop app with aura.

- **3 NaiveProxy servers** (ap-melbourne-1): `romeo`, `juliet`, `mercutio` → `*.api.copal.run`
- **Cloudflare Worker** at `api.copal.run` — central config API (server list + creds, KV-backed)
- **Aura app** (Windows + macOS) — Flutter, runs bundled sing-box in TUN mode, auto-selects fastest server

## Layout

```
infra/          PowerShell provisioning (OCI + Cloudflare + server bootstrap)
config/         sing-box client template
worker/         Cloudflare Worker (config API)
app/            Flutter desktop app
.github/        CI builds (Windows + macOS)
```

## Server flow

```
infra/00-EnsureSession.ps1     OCI auth (browser)
infra/01-Discover.ps1          find VPN1 topology → discovered.json
infra/02-EnsureCapacity.ps1    resize VPN1 if it eats the free pool
infra/03-NewServers.ps1        launch juliet + mercutio → ips.txt
infra/04-CloudflareDns.ps1     grey A records (proxies) + orange api record
infra/05-Bootstrap.ps1         Caddy+naiveproxy on all 3 servers
```

## App flow

Aura login (account id + token) → `POST api.copal.run/v1/session` (checks out rotating
server creds) → generate sing-box config (3 naive outbounds in urltest group, TUN +
fakeip DNS) → run bundled sing-box elevated → live latency/traffic via Clash API.

## Downloads

| Artifact | URL |
|---|---|
| Windows | `https://api.copal.run/dl/latest` |
| macOS (Apple Silicon) | `https://api.copal.run/dl/latest-macos` |
| Source | `https://api.copal.run/dl/source` |

No account? Create one in the app — it stays disabled until an admin adds
credit (days) to it.

## The Rules

1. **No illegal stuff.**
2. **No piracy.**
3. **No torrenting.**
4. **Use your data wisely** (100 GB/month per account).
5. **Pay on time.**

## Notes

- Proxy records must stay **grey-cloud** (DNS only) — Cloudflare proxying would terminate TLS and break naive.
- `prefer_ip` in the Worker KV payload switches the app to raw-IP connect if the domain ever gets DNS-poisoned.
- Unsigned builds: Windows "More info → Run anyway", macOS right-click → Open.
- Admin panel at `https://api.copal.run/admin`.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved; the compiled app is
for personal use by authorized account holders only.
