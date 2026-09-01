# Aura desktop 0.3.0

Flutter desktop UI for Aura on Windows and macOS.

The app is intentionally unprivileged. It generates session configuration and
talks to `aura-core` over an authenticated loopback API. `aura-core` owns TUN,
NaiveProxy + UDP-over-TCP lifecycle, validation, logs, and recovery.

Release bundles place the helper beside the executable:

```
aura-core/
  aura-core[.exe]
  naive[.exe]
  wintun.dll        # Windows
```
