# Aura (Tauri React + Rust port)

An **experimental** port of the Aura Flutter desktop app to **Tauri v2** with a
**React + TypeScript** frontend and a **Rust** backend.

> Lives in an isolated git worktree on the `exp/aura-tauri` branch
> (path: `.worktrees/aura-tauri`) so it doesn't touch the `master` working tree.

## What's ported

The architecture is a faithful mirror of the Flutter app, with the OS/network
boundary moved from Dart into Rust:

| Flutter (Dart) | This port (Rust / React) |
|---|---|
| `AppState` (ChangeNotifier) | `src/state/useAura.ts` (React hook) |
| `SessionService` (HTTP) | `src-tauri/src/api.rs` (reqwest) |
| `ConfigGenerator` (config.json) | generated inline in `core::start` |
| `AuraCoreManager` (privileged helper API) | `src-tauri/src/core.rs` (simulated engine) |
| `UsageTracker` (monthly bytes) | `src-tauri/src/usage.rs` (persisted JSON) |
| `UpdateService` (release meta) | `api::check_update` |
| `aura_lines.dart` (meme copy) | `src/lib/lines.ts` |
| `_AsteriskPainter` / UI | `src/components/*` + shadcn/ui |

## The tunnel (real TUN)

This port **delegates the whole tunnel lifetime to the real privileged `aura-core`
daemon** — the same root helper the shipped Flutter Aura uses. On connect it
builds a config from the session's fresh server creds and POSTs it to
`http://127.0.0.1:45873/v1/start`, which brings up a **real system-wide TUN device**
(NaiveProxy + gVisor netstack + system routes, as root). `stop`/`stats`/`status`/
`log` proxy straight to that daemon. So connecting here is a genuine VPN, not a
simulation.

Prereqs: the real Aura helper must be installed (macOS:
`/Library/PrivilegedHelperTools/com.copal.aura.core/aura-core`), and you must be
logged in (fresh session creds). The helper's API token is auto-discovered.

> Kill-switch and split-tunnel exception toggles are stored in settings but are
> not yet enforced by the daemon (its config schema doesn't include them).

## Stack

- Tauri 2 (Rust) + Vite + React 19 + TypeScript
- shadcn/ui + Tailwind CSS v4
- `reqwest` (rustls) for the Cloudflare Worker API at `api.copal.run`
- `chrono` for the monthly usage key

## Run

```bash
npm install
npm run tauri dev     # native window (Vite on :1420)
```

The app still talks to the **real** `api.copal.run` Worker for Discord OAuth and
server config, so a valid Aura account/session is required to log in. Connection
uses the simulated engine.

## API base

Default: `https://api.copal.run` (`api::API_BASE`). Change it there to point the
experiment at a local/mock Worker.

## Worktree

Created from `master` with:

```bash
git worktree add .worktrees/aura-tauri -b exp/aura-tauri
```
