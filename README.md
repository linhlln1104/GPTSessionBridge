# GPTSessionBridge

GPTSessionBridge is a local bridge that lets a Codex client route an explicitly selected thread to a ChatGPT Web model while the user's ChatGPT session remains inside their existing browser.

> [!WARNING]
> This project is pre-alpha and not production-ready. The UI-only ChatGPT adapter and local Responses integration are implemented for bounded plain-text turns on an explicitly selected fresh chat. The package is unsigned, real-account compatibility is not certified, and normal Codex coding requests that carry developer instructions or tool definitions remain unsupported and fail closed. Protocol v2 boundaries and local consent UI are present for testing, but no v2 transport or Web Agent model is active.

## Design goals

- Never ask users to sign in to ChatGPT inside an unfamiliar desktop application.
- Never export or persist ChatGPT cookies, access tokens, or browser profiles.
- Operate only visible ChatGPT UI; never call undocumented or private ChatGPT backend endpoints.
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
        |         +--> authenticated local Responses provider
        |
        +--> BrowserSessionCoordinator
                 |
                 | authenticated Windows named pipe
                 v
          Native Messaging host <--> MV3 extension <--> selected chatgpt.com tab
```

The facade launches the official Codex app-server, preserves the JSON meaning of unowned protocol messages, and projects the selected tab's current visible model catalog into paginated `model/list` results. Selecting a `Web · …` entry pins an opaque provider route to the exact browser catalog revision. The Responses provider then carries supported plain-text turns through the authenticated coordinator, Native Messaging host, MV3 extension, and visible ChatGPT UI.

### Available now

- A runnable stdio app-server facade backed by the official Codex child process.
- Semantic pass-through for unowned app-server messages.
- Paginated native model discovery augmented with the currently connected tab's visible Web models.
- Thread-scoped Web provider, model, reasoning-effort, and catalog-revision pinning.
- An authenticated, loopback-only Responses endpoint with strict text-only parsing, bounded streaming, backpressure, safe errors, and disconnect cancellation.
- Explicit rejection of provider switching, reserved provider/config overrides, Web review/realtime/steering flows, and unsupported resume identities.
- A strict 4-byte Native Messaging codec with a symmetric 1 MiB frame limit, bounded buffering and writes, exact UTF-8/JSON/schema validation, and serialized backpressure handling.
- Independent extension and bridge link state machines with peer, version, sequence, heartbeat, direction, and extension-origin checks.
- A self-contained .NET Windows helper with a protected logon-SID pipe DACL, first-instance ownership, remote-client rejection, and mutual peer token verification.
- A bounded `BrowserSessionCoordinator` that owns one authenticated transport, immutable capability snapshots, one active turn, backpressure, cancellation races, and exactly one terminal result.
- A Native Messaging runtime that opens bridge IPC only after validating the exact extension origin and completing the extension-side handshake.
- A Manifest V3 extension that connects only an explicitly selected `https://chatgpt.com` tab using `activeTab`, `scripting`, and `nativeMessaging`; its isolated content adapter reads semantic visible UI, discovers the model picker, verifies selection, submits bounded text, streams visible assistant text, and requests no cookie, debugger, storage, history, or broad host access.
- A direct Chrome Stable DOM-runtime fixture that exercises the production UI driver against a synthetic local document, including nested model selection, raw-picker drift, real DOM events and observers, visible-text filtering, streaming, and cancellation.
- Inactive protocol v2 boundaries: strict request/continuation admission and Responses lifecycle mapping, a certified closed-schema evaluator, an in-memory `AgentSessionCoordinator`, and a typed one-shot adapter with replay and at-most-once guards.
- A memory-only extension activation/consent UI bound to the exact selected tab and document. It expires after 15 minutes of inactivity and is invalidated by navigation, document replacement, disconnect, extension restart, or explicit deactivation.
- A Windows x64 development package containing a pinned Node 24 single-executable Native Host, its adjacent self-contained IPC helper, the unpacked MV3 extension, and a strict content-hash manifest.
- Conservative per-user `install`, `status`, and `uninstall` commands using the development-only `com.gptsessionbridge.native_host.dev` HKCU identity. Setup reconciles both Chrome registry views in precedence-aware order, refuses foreign ownership, and never edits a Chrome profile.

### Not available yet

- Runtime support for Codex developer instructions, tool definitions or calls, images, structured output, previous-response chaining, or other Responses semantics that cannot be preserved by protocol v1.
- A complete coding-agent workflow through ChatGPT Web. The adapter never imitates tool calls by parsing prose.
- Protocol v2 Native Messaging/page capability negotiation, coordinator-to-DOM agent transport, admitted-activity lease renewal wiring, current Codex-child approval/execution fixtures, and a published `Web Agent (experimental)` catalog entry.
- A signed production installer, protected per-machine installation, reserved Chrome Web Store identity, or code signing.
- A redistributable release bundle with a completed third-party license inventory.
- Packaged-MV3/native-host Chrome E2E or real-account compatibility certification. The direct Chrome DOM-runtime gate uses a synthetic local document, does not load the extension package, and never visits ChatGPT.

A Web model is advertised only while an explicitly selected tab has supplied a valid capability snapshot. The first turn requires a fresh ChatGPT surface at `/` with no existing transcript. The adapter never navigates to New chat or appends to an arbitrary existing conversation. Catalog or selected-model drift detected by the final pre-submit revalidation fails closed before the composer is changed. The composer write and Send click then run synchronously. After that click, a new catalog applies only to future routes; the active owned turn continues without replay or rerouting while its conversation ownership and visible response surface remain valid. If visible start confirmation fails after the click, the turn fails without automatic replay, and the prompt may still appear in ChatGPT history.

The adapter supports a direct model picker and the currently observed nested submenu whose accessible name is the English word `Model`. Localized ChatGPT picker variants are not certified; an unrecognized or ambiguous UI makes the Web catalog or turn unavailable instead of guessing.

The bridge adds no ChatGPT conversation persistence or cleanup. Prompts and responses submitted through the visible composer may remain in ChatGPT history according to the user's account settings.

On disconnect or teardown, the adapter makes a best-effort attempt to click a currently visible, verified Stop control for its active turn. If the selected document or transport is already unavailable, or the Stop control has not become visible, the bridge cannot confirm that ChatGPT stopped generating; the user should check the selected tab because generation and Web usage may continue.

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
- Google Chrome Stable 151 or newer for the direct DOM-runtime verification gate
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
corepack pnpm test:chrome-dom
corepack pnpm build
corepack pnpm smoke:app-server
corepack pnpm package:windows
corepack pnpm native-host:install
corepack pnpm native-host:status
corepack pnpm native-host:uninstall
```

`smoke:app-server` builds the workspace, launches the facade against the installed Codex CLI, and verifies the app-server handshake plus an empty fail-closed Web catalog when no tab is connected. On Windows x64, `package:windows` also launches the packaged SEA executable against the packaged IPC helper from an empty temporary working directory and verifies a bidirectional Native Messaging relay without changing the registry. Windows CI separately opts into an install/status/uninstall round trip across both registry views under the isolated `.dev` HKCU key and refuses any pre-existing value. Automated tests cover dynamic model projection, exact revision routes, Responses streaming and rejection behavior, protocol v2 envelope/request/continuation parsing, one-shot coordinator integration, activation expiry and SPA-navigation invalidation, real Chrome DOM behavior on synthetic pages, Windows IPC, coordinator lifecycle, setup ownership, and MV3 output policy. They do not visit ChatGPT, submit a prompt to ChatGPT Web, or use a real account.

See [Windows development setup](docs/development/windows-native-host.md) before registering the development host or loading the unpacked extension.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Project status

Phase 2 establishes a runnable app-server facade, model-catalog augmentation, fail-closed thread routing, an authenticated local provider boundary, and versioned protocols. Phase 3 adds the authenticated Windows/Native Messaging transport, `BrowserSessionCoordinator`, explicit-tab MV3 shell, and verified development package. Phase 4 adds a UI-only ChatGPT DOM adapter, dynamic Web model catalog, revision-bound provider routes, strict text-only Responses streaming, and a direct synthetic Chrome DOM gate. The current protocol v2 increment implements inactive request/lifecycle, schema, agent-session, one-shot integration, and document-bound consent boundaries. Tool-capable transport activation, model publication, production signing, and real-account certification remain deliberately excluded.

The current compatibility snapshot was tested on 2026-08-26 with Codex CLI `0.150.0-alpha.8`, Node.js `24.18.1`, Chrome Stable `151.0.7922.174`, and Windows x64. See [Compatibility](docs/compatibility.md) for the exact scope and limitations.

GPTSessionBridge is an independent project. It is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of their respective owner.

The architecture was informed by the MIT-licensed [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. GPTSessionBridge uses a different browser-session boundary and is being implemented clean-room unless a future notice states otherwise.

## License

[MIT](LICENSE)
