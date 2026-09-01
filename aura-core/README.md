# aura-core

`aura-core` is Aura's privileged, cross-platform tunnel supervisor. It exposes
an authenticated API on `127.0.0.1:45873` and is the only process allowed to
start the bundled Naive + UDP-over-TCP engine.

The Flutter app does not elevate, manage PID files, or invoke the engine. On
first connection it installs this helper once:

- Windows: highest-privilege per-user scheduled helper, restarted on failure.
- macOS: `com.copal.aura.core` LaunchDaemon in PrivilegedHelperTools.

The API accepts only Aura's client config shape. Server inbounds, unexpected
engine types, and filesystem paths are rejected before the privileged process
writes the config into its protected runtime directory.

## Development

```sh
go test ./...
go vet ./...
go build ./...
```

Release builds package `aura-core/{aura-core,engine/sing-box}`. The Naive/UoT
engine is private to this boundary and can later be replaced without changing
the desktop application.
