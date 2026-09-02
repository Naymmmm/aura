# Changelog

## 26.0.1

- Adopted `year.minor.hotfix` release versions.
- Added remote Discord authorization handoff for filtered networks and restored
  legacy credentials behind the secondary sign-in options.
- Added explicit server selection and pinned the chosen server while connected.
- Enabled native IPv6 egress across the Aura server pool and future replacements.
- Reworked the desktop UI, app/tray icons, and searchable structured diagnostics.
- Replaced the macOS ZIP with a DMG and a checksum-verified AppleScript updater
  that installs, relaunches, and posts a completion notification.

## 0.3.2

- Restored Chromium HTTP/3 and QUIC traffic over the encrypted UoT v2 tunnel
  now that the pinned sing-box server includes the Naive padding fix.
- Made Windows tunnel interface setup safe to repeat, preventing reconnects
  from failing when the expected Aura addresses already exist.

## 0.3.0

- Replaced the client-side sing-box engine with Aura Core's embedded TUN
  netstack, direct NaiveProxy transport, and native UDP-over-TCP v2 framing.
- Fixed a live-stats socket leak that exhausted the app's file descriptors.
- Status now follows the privileged tunnel engine instead of telemetry alone.
- Prevented overlapping stats polls and moved live totals to Aura Core's API.
- Windows now installs aura-core as a boot-persistent SYSTEM helper for reliable TUN access.
- Cleans up tunnels left behind by a previous hard crash at the next launch.
- Bundles Wintun beside Aura Core on Windows and removes client-side Clash API
  and sing-box configuration assets.
- Pins proxy transports to pre-tunnel IPv4 routes and captures dual-stack IPv6
  traffic to prevent routing loops and bypasses.
- Forces browser QUIC to fall back to HTTP/2 because the current server-side
  Naive UoT implementation stalls large QUIC flows; other UDP remains on UoT.
- Measures real end-to-end TLS latency and enables TUN TCP receive autotuning.

## 0.2.6

- Added `aura-core`, an authenticated privileged helper for Windows and macOS.
- Reduced elevation to helper installation/upgrades instead of every connect.
- Kept NaiveProxy with UDP-over-TCP v2 behind the new engine boundary.
- Added protected runtime configuration, schema validation, lifecycle logs, and
  engine crash detection.
- Closing or quitting Aura now waits for tunnel/TUN cleanup before exiting.
- Reworked the desktop dashboard and connection controls.
- Rebuilt Windows packaging around a restartable hidden helper and a clean,
  minimal engine bundle.
