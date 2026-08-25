# GPTSessionBridge

GPTSessionBridge is a local bridge that lets a Codex client route an explicitly selected thread to a ChatGPT Web model while the user's ChatGPT session remains inside their existing browser.

> [!WARNING]
> This project is pre-alpha and not production-ready. The authenticated Windows IPC, browser-session coordinator, Native Messaging runtime, explicit-tab Manifest V3 shell, and reversible per-user development packaging are implemented and tested. The package is unsigned, and the ChatGPT page adapter and Responses integration are not implemented. A Web request currently fails with `session_not_connected` after the local provider boundary verifies it.

## Design goals

- Never ask users to sign in to ChatGPT inside an unfamiliar desktop application.
- Never export or persist ChatGPT cookies, access tokens, or browser profiles.
- Let users choose a connected Web model from the Codex model picker.
- Keep Codex authentication, approvals, sandboxing, and native threads under the official Codex app-server.
- Fail closed when a browser session, model, or protocol capability is unavailable.
- Keep diagnostics content-free and telemetry disabled by default.

## Architecture

```text
Codex IDE extension
        |
        | app-server protocol
        v
GPTSessionBridge facade --------> official Codex app-server
        |        \
        |         +--> local Responses provider (terminal 503 today)
        |
        +--> BrowserSessionCoordinator
                 |
                 | authenticated Windows named pipe
                 v
          Native Messaging host <--> MV3 extension <--> selected chatgpt.com tab
```

The Phase 2 facade launches the official Codex app-server, preserves the JSON meaning of unowned protocol messages, appends a synthetic Web model to paginated `model/list` results, and pins the local Web provider when that model is selected. The current Phase 3 increment adds an authenticated Windows rendezvous, two independent Native Messaging links, an in-memory browser-session coordinator, a least-privilege extension shell, and a content-addressed Windows development package. The page adapter remains deliberately unavailable, so no real Web turn is submitted.

### Available now

- A runnable stdio app-server facade backed by the official Codex child process.
- Semantic pass-through for unowned app-server messages.
- Paginated native model discovery with a synthetic `gptsessionbridge/web/example-model` entry.
- Thread-scoped Web provider, model, reasoning-effort, and catalog-revision pinning.
- An authenticated, loopback-only Responses endpoint with bounded request handling.
- Explicit rejection of provider switching, reserved provider/config overrides, Web review/realtime/steering flows, and unsupported resume identities.
- A strict 4-byte Native Messaging codec with a symmetric 1 MiB frame limit, bounded buffering and writes, exact UTF-8/JSON/schema validation, and serialized backpressure handling.
- Independent extension and bridge link state machines with peer, version, sequence, heartbeat, direction, and extension-origin checks.
- A self-contained .NET Windows helper with a protected logon-SID pipe DACL, first-instance ownership, remote-client rejection, and mutual peer token verification.
- A bounded `BrowserSessionCoordinator` that owns one authenticated transport, immutable capability snapshots, one active turn, backpressure, cancellation races, and exactly one terminal result.
- A Native Messaging runtime that opens bridge IPC only after validating the exact extension origin and completing the extension-side handshake.
- A Manifest V3 extension shell that connects only an explicitly selected `https://chatgpt.com` tab using `activeTab`, `scripting`, and `nativeMessaging`; it requests no cookie, debugger, storage, history, or broad host access.
- A Windows x64 development package containing a pinned Node 24 single-executable Native Host, its adjacent self-contained IPC helper, the unpacked MV3 extension, and a strict content-hash manifest.
- Conservative per-user `install`, `status`, and `uninstall` commands using the development-only `com.gptsessionbridge.native_host.dev` HKCU identity. Setup reconciles both Chrome registry views in precedence-aware order, refuses foreign ownership, and never edits a Chrome profile.

### Not available yet

- Real ChatGPT Web model discovery or response streaming.
- A reviewed ChatGPT DOM adapter or any credential/backend extraction path.
- A signed production installer, protected per-machine installation, reserved Chrome Web Store identity, or code signing.
- A redistributable release bundle with a completed third-party license inventory.
- Automated real-Chrome or real-account compatibility certification. Development setup is intentionally separate from a production distribution claim.
- Responses-to-coordinator integration with trustworthy pinned `catalogRevision` propagation.

The current Responses endpoint therefore returns HTTP 503 with `session_not_connected` for a valid Web request. The synthetic model exists to verify the facade and model-picker integration; it is not a usable ChatGPT model.

Switching between Codex and Web providers requires a new thread. The bridge never silently falls back to another provider or model.

Only one facade in a Windows logon session can own the deterministic browser IPC listener. If the helper is unavailable or another facade already owns that listener, the affected process keeps native Codex operational while Web requests remain fail-closed; it never redirects them to native usage.

See [Architecture](docs/architecture.md), [Security model](docs/security-model.md), and [Privacy](docs/privacy.md) for the current contracts.

The integration surface is based on the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Repository layout

```text
apps/       Executable bridge, Native Messaging host, and browser extension
packages/   Runtime contracts and I/O-free core logic
tests/      Cross-package contract and integration tests
docs/       Architecture, security, compatibility, and decision records
```

Only packages that contain working code are added to the repository.

## Development

Requirements:

- Node.js 24.18.1
- Corepack
- Git
- .NET SDK 10.0.301 on Windows when building or verifying the named-pipe helper

```shell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Useful commands:

```shell
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:app-server
corepack pnpm package:windows
corepack pnpm native-host:install
corepack pnpm native-host:status
corepack pnpm native-host:uninstall
```

`smoke:app-server` builds the workspace, launches the facade against the installed Codex CLI, and verifies the app-server handshake plus synthetic model catalog contract. On Windows x64, `package:windows` also launches the packaged SEA executable against the packaged IPC helper from an empty temporary working directory and verifies a bidirectional Native Messaging relay without changing the registry. Windows CI separately opts into an install/status/uninstall round trip across both registry views under the isolated `.dev` HKCU key and refuses any pre-existing value. Automated integration tests verify the current `session_not_connected` provider response, Windows IPC authentication, coordinator lifecycle, setup ownership and detected-race handling, and MV3 output policy. None of these paths contacts ChatGPT Web or a real account.

See [Windows development setup](docs/development/windows-native-host.md) before registering the development host or loading the unpacked extension.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Project status

Phase 2 establishes a runnable app-server facade, model-catalog augmentation, fail-closed thread routing, an authenticated local provider boundary, and versioned protocols. Phase 3a adds a tested Native Messaging transport and direction-aware relay foundation. Phase 3b adds authenticated Windows IPC, `BrowserSessionCoordinator`, Native Host runtime wiring, and an explicit-tab MV3 shell. The current Phase 3c increment adds a verified self-contained development package and reversible per-user Native Messaging registration. Browser automation, Responses integration, production signing, and real-account fixtures remain deliberately excluded.

The current compatibility snapshot was tested on 2026-08-25 with Codex CLI `0.149.0-alpha.4.3`, Node.js `24.18.1`, and Windows x64. See [Compatibility](docs/compatibility.md) for the exact scope and limitations.

GPTSessionBridge is an independent project. It is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of their respective owner.

The architecture was informed by the MIT-licensed [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. GPTSessionBridge uses a different browser-session boundary and is being implemented clean-room unless a future notice states otherwise.

## License

[MIT](LICENSE)
