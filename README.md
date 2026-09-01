# Aura 🏆

DPI-resistant VPN on Oracle Cloud Always Free + a Flutter desktop app with aura.

- **3 NaiveProxy servers** (ap-melbourne-1): `romeo`, `juliet`, `mercutio` → `*.api.copal.run`
- **Cloudflare Worker** at `api.copal.run` — central config API (server list + creds, KV-backed)
- **Aura app** (Windows + macOS) — Flutter UI backed by the persistent `aura-core` privileged helper

## Layout

```
infra/          PowerShell provisioning (OCI + Cloudflare + server bootstrap)
worker/         Cloudflare Worker (config API)
app/            Flutter desktop app
aura-core/      authenticated helper/service and tunnel-engine boundary
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
infra/07-EnableUdpOverTcp.ps1  migrate servers to sing-box Naive for encrypted UDP-over-TCP v2
```

## App flow

Aura opens Discord OAuth in the browser → saves an Aura bearer token for 14 days →
`POST api.copal.run/v1/session` checks out rotating server credentials → generates
the Naive + UoT config → sends it to `aura-core` over an authenticated loopback API →
the already-privileged helper starts NaiveProxy and its embedded TUN/UoT v2 stack →
live latency/traffic via Aura Core's API. Legacy account IDs and generated API
tokens are no longer accepted.

The helper needs one administrator approval when first installed (and when the
helper itself is upgraded), not on every connection. Closing Aura stops the
tunnel and waits for TUN/route cleanup before the desktop process exits.

## Downloads

Open `https://api.copal.run/downloads` and sign in with Discord. The portal and
all direct artifact URLs require membership of the configured Aura Discord role.

| Artifact | URL |
|---|---|
| Windows | `https://api.copal.run/dl/latest` |
| macOS (Apple Silicon) | `https://api.copal.run/dl/latest-macos` |
| Source | `https://api.copal.run/dl/source` |

Tagged builds keep immutable Windows, macOS, and tracked-source ZIPs in the
version archive. The three stable URLs above follow the newest published tag.

### Discord authentication and bot setup

Create a Discord application with a bot and register both OAuth2 redirect URIs:

```text
https://api.copal.run/auth/discord/callback
https://api.copal.run/v1/auth/discord/callback
```

Set the application's Interactions Endpoint URL to:

```text
https://api.copal.run/v1/discord/interactions
```

Configure the Worker secrets from `worker/` (values are read at runtime and are
not committed):

```powershell
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_STAFF_ROLE_ID
npx wrangler secret put DISCORD_LOG_CHANNEL_ID
npx wrangler secret put DISCORD_TRIAL_CHANNEL_ID
npx wrangler secret put DISCORD_RELEASE_CHANNEL_ID
npx wrangler secret put DOWNLOAD_SESSION_SECRET
npx wrangler secret put RELEASE_UPLOAD_TOKEN
```

Use a cryptographically random value for each signing/upload token. Add the same
`RELEASE_UPLOAD_TOKEN` value to the GitHub Actions repository secret named
`AURA_RELEASE_UPLOAD_TOKEN`. The required role is pinned in `wrangler.toml` to
`1544233739322789948`. OAuth requests use `identify guilds.members.read`; access
is rechecked when the short-lived download session expires. The app token is
opaque, stored locally, and expires after 14 days.

Register the guild commands after exporting the Discord application, guild, and
bot token values in your shell:

```powershell
npm run register:discord
```

Run `/trial-panel` in the configured free-trial channel to post the green claim
embed. Each Discord member can claim one 7-day trial with 1 GB. Staff commands
include `/upgrade` (30 Standard days), `/credits` (AUD-to-days), `/days`,
`/budget`, `/trial-replenish`, `/account`, and `/logs`. A$2 buys 30 days; amounts
covering at least three months use the 10%-off A$1.80 monthly rate. Every change
is stored in the audit log and mirrored to the configured log channel. An hourly
Worker schedule removes the customer/download role and downgrades expired
Standard accounts. Free trials may download app binaries but not source code.

Tagged releases require `releases/<tag>.md`. After all three archives upload,
the Worker posts that changelog in `DISCORD_RELEASE_CHANNEL_ID` as the Aura bot.
The bot role needs permission to mention the Customers role so release pings
notify `<@&1544233739322789948>`.
The optional always-online Gateway presence service and VPS instructions live in
`presence/`; Cloudflare remains responsible for all bot behavior.

No access yet? Claim the free trial from the Aura Discord free-trial channel,
then continue with Discord in the app.

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
- Tagged GitHub Actions builds publish the Windows and macOS ZIPs to both the
  GitHub Release and the Worker's R2-backed auto-update endpoints.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved; the compiled app is
for personal use by authorized account holders only.
