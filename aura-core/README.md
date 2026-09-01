# aura-core

`aura-core` is Aura's privileged, cross-platform tunnel supervisor. It exposes
an authenticated API on `127.0.0.1:45873`. It owns the TUN interface, routes,
embedded userspace network stack, bundled NaiveProxy transport, and Aura's
native UDP-over-TCP v2 implementation.

The Flutter app does not elevate, manage PID files, or invoke the engine. On
first connection it installs this helper once:

- Windows: boot-persistent SYSTEM scheduled helper, restarted on failure.
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

Release builds package `aura-core/{aura-core,naive}` plus `wintun.dll` on
Windows. TCP uses NaiveProxy's local SOCKS endpoint; UDP is framed by Aura Core
as UoT v2 over the same encrypted TCP transport. No sing-box executable or
configuration is shipped in the desktop client.
