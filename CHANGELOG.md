# Changelog

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
