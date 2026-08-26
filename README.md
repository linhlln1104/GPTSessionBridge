# GPTSessionBridge

GPTSessionBridge is a local bridge that lets a Codex client route an explicitly selected thread to a ChatGPT Web model while the user's ChatGPT session remains inside their existing browser.

> [!WARNING]
> This project is an unsigned, pre-alpha personal-use MVP, not a production release. The activation-gated Web Agent route is implemented for a bounded function-tool workflow on one explicitly selected fresh ChatGPT tab. Real-account compatibility is not certified, ChatGPT DOM changes can disable the route without notice, and no public release or support claim is made.

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

The facade launches the official Codex app-server, preserves the JSON meaning of unowned protocol messages, and projects the selected tab's current visible model catalog into paginated `model/list` results. A text route is published as `Web · …`; while document-bound tool consent is active, the same visible catalog is published as `Web Agent · …`. Either selection pins an opaque provider route to the exact browser catalog revision. The local Responses provider carries the selected workflow through the authenticated coordinator, Native Messaging host, MV3 extension, and visible ChatGPT UI.

### Available now

- A runnable stdio app-server facade backed by the official Codex child process.
- Semantic pass-through for unowned app-server messages.
- Paginated native model discovery augmented with the currently connected tab's visible Web models.
- Thread-scoped Web provider, model, reasoning-effort, and catalog-revision pinning.
- An authenticated, loopback-only Responses endpoint with separate strict text and Web Agent request paths, bounded streaming, backpressure, safe errors, and disconnect cancellation.
- Explicit rejection of provider switching, reserved provider/config overrides, Web review/realtime/steering flows, and unsupported resume identities.
- A strict 4-byte Native Messaging codec with a symmetric 1 MiB frame limit, bounded buffering and writes, exact UTF-8/JSON/schema validation, and serialized backpressure handling.
- Independent extension and bridge link state machines with peer, version, sequence, heartbeat, direction, and extension-origin checks.
- A self-contained .NET Windows helper with a protected logon-SID pipe DACL, first-instance ownership, remote-client rejection, and mutual peer token verification.
- A bounded `BrowserSessionCoordinator` that owns one authenticated transport, immutable capability snapshots, one active turn, backpressure, cancellation races, and exactly one terminal result.
- A Native Messaging runtime that opens bridge IPC only after validating the exact extension origin and completing the extension-side handshake.
- A Manifest V3 extension that connects only an explicitly selected `https://chatgpt.com` tab using `activeTab`, `scripting`, and `nativeMessaging`; its isolated content adapter reads semantic visible UI, discovers the model picker, verifies selection, submits bounded text, streams visible assistant text, and requests no cookie, debugger, storage, history, or broad host access.
- A direct Chrome Stable DOM-runtime fixture that exercises the production UI driver against a synthetic local document, including nested model selection, raw-picker drift, real DOM events and observers, visible-text filtering, streaming, and cancellation.
- An active protocol v2 path with strict Codex request/continuation projection, whole-response envelope validation, a certified closed-schema evaluator, `ResponsesServerV2`, `AgentSessionCoordinator`, and at-most-once function-call commit.
- Authenticated v2 Native Messaging and page transport with an exact one-shot agent-turn permit bound to the selected browser session, tab, document generation, conversation ownership, activation lease, and catalog route.
- A memory-only extension activation/consent UI bound to the exact selected tab and document. It expires after 15 minutes without admitted agent activity and is invalidated by unrelated navigation, document replacement, disconnect, extension restart, or explicit deactivation.
- Dynamic `Web Agent · …` model publication while that exact consent lease is active. The Web response can propose a certified function call, but the official Codex child remains the only component that handles approval, sandboxing, execution, and the resulting continuation.
- A Windows x64 development package containing a pinned Node 24 single-executable facade and Native Host, their adjacent self-contained IPC helper, the unpacked MV3 extension, and a strict content-hash manifest.
- Conservative per-user `install`, `status`, and `uninstall` commands using the development-only `com.gptsessionbridge.native_host.dev` HKCU identity. Setup reconciles both Chrome registry views in precedence-aware order, refuses foreign ownership, and never edits a Chrome profile.

### Not available yet

- Full Responses API equivalence. The MVP admits only the tested, bounded text and certified function-tool projection; media, remote or built-in tools, parallel tool calls, arbitrary item types, persistence, and unsupported continuation shapes fail closed.
- Native developer-role priority on ChatGPT Web. Instructions, source excerpts, tool schemas, arguments, and tool results are labeled compatibility data in one visible user-role conversation.
- A signed production installer, protected per-machine installation, reserved Chrome Web Store identity, or code signing.
- A redistributable release bundle with a completed third-party license inventory.
- Stable ChatGPT DOM, packaged-extension, or real-account compatibility certification. Automated DOM gates use synthetic local documents and never sign in to or submit content to ChatGPT.
- Persistent Web route metadata. After the facade or VS Code restarts, start a new Web thread; native Codex thread resume remains unaffected.

A Web model is advertised only while an explicitly selected tab has supplied a valid capability snapshot. A Web Agent model additionally requires the current 15-minute document-bound consent lease. The first turn requires a fresh ChatGPT surface at `/` with no existing transcript. The adapter may adopt only the initial `/` to `/c/...` transition created by its own submitted prompt and exact user-message anchor; it never clicks New chat or appends to an arbitrary existing conversation. Any unrelated navigation invalidates the agent permit and lease. Catalog or selected-model drift detected by the final pre-submit revalidation fails closed before the composer is changed. The composer write and Send click then run synchronously. After that click, a new catalog applies only to future routes; the active owned turn continues without replay or rerouting while its conversation ownership and visible response surface remain valid. If visible start confirmation fails after the click, the turn fails without automatic replay, and the prompt may still appear in ChatGPT history.

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

## Personal-use MVP quickstart

The current runnable target is Windows x64 with Google Chrome and the official Codex VS Code extension. Keep the extension's normal Codex authentication and approval flow in place; GPTSessionBridge does not replace or copy it. Sign in to ChatGPT only in the Chrome tab you intend to use.

1. Install dependencies and create the verified per-user development package:

   ```shell
   corepack pnpm install --frozen-lockfile
   corepack pnpm verify
   corepack pnpm native-host:install
   ```

2. Keep the JSON object printed by `native-host:install`. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the exact `extensionPath` returned by setup.
3. In VS Code settings, set `chatgpt.cliExecutable` to the exact `facadeExecutablePath` returned by setup, set `chatgpt.runCodexInWindowsSubsystemForLinux` to `false`, and reload VS Code. Replace the placeholder below; do not copy it literally:

   ```json
   {
     "chatgpt.cliExecutable": "<facadeExecutablePath returned by setup>",
     "chatgpt.runCodexInWindowsSubsystemForLinux": false
   }
   ```

4. Open a new, transcript-free `https://chatgpt.com/` tab. Leave that exact conversation open, press the unpacked extension's **Connect** action, read and accept the Web Agent disclosure, then activate its 15-minute consent lease. Do not navigate the selected tab manually.
5. Start a new Codex thread in VS Code, refresh the model picker if needed, and choose `Web Agent · <visible ChatGPT model>`. The entry is available only while the selected document and consent lease remain valid.
6. Send a coding request. Prompts, source excerpts, tool arguments, tool results, and final responses are visible in the selected ChatGPT conversation and may remain in ChatGPT history. A Web tool envelope is only a proposal: approvals appear through the normal Codex client, and the official Codex child applies its configured sandbox and performs any local execution.

The bridge never extracts ChatGPT cookies or tokens and never calls a private ChatGPT backend. If the tab, model, consent, DOM ownership, or protocol contract changes, the Web route fails closed instead of switching to native Codex usage. This manual flow is intended for personal evaluation; a successful run is not a real-account or public-release certification.

### Roll back to native Codex

1. Restore the previous `chatgpt.cliExecutable` value, or remove the override, then reload VS Code.
2. Deactivate and disconnect the selected tab, then remove the unpacked extension from `chrome://extensions`.
3. Remove the development Native Messaging registration:

   ```shell
   corepack pnpm native-host:uninstall
   ```

Uninstall deliberately retains content-addressed build artifacts for conservative recovery; it removes the managed registry entries but does not edit Chrome profiles or ChatGPT history.

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

`smoke:app-server` builds the workspace, launches the facade against the installed Codex CLI, and verifies the app-server handshake plus an empty fail-closed Web catalog when no tab is connected. On Windows x64, `package:windows` launches the packaged facade and Native Host against the packaged IPC helper from an empty temporary working directory and verifies the expected process roles and bidirectional Native Messaging relay without changing the registry. Windows CI separately opts into an install/status/uninstall round trip across both registry views under the isolated `.dev` HKCU key and refuses any pre-existing value. Automated tests cover dynamic text and Web Agent model projection, exact revision routes, Responses v1/v2 streaming and rejection behavior, protocol v2 envelope/request/continuation parsing, agent coordinator integration, one-shot document permits, activation expiry and navigation invalidation, real Chrome DOM behavior on synthetic pages, Windows IPC, coordinator lifecycle, setup ownership, and MV3 output policy. They do not sign in to ChatGPT, submit a prompt to a real ChatGPT account, or certify the current site UI.

See [Windows development setup](docs/development/windows-native-host.md) before registering the development host or loading the unpacked extension.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Project status

Phase 2 establishes the app-server facade, model-catalog augmentation, fail-closed thread routing, authenticated local provider boundary, and versioned protocols. Phase 3 adds the authenticated Windows/Native Messaging transport, `BrowserSessionCoordinator`, explicit-tab MV3 shell, and verified development package. Phase 4 adds the UI-only ChatGPT DOM adapter, dynamic text model catalog, revision-bound routes, strict text Responses streaming, and direct synthetic Chrome DOM gate. The current MVP activates protocol v2 end to end: current-Codex contract projection, `ResponsesServerV2`, `AgentSessionCoordinator`, authenticated agent transport, document-bound consent, exact DOM envelopes, child-owned tool continuation, and `Web Agent · …` publication. Production signing, protected installation, stable DOM support, packaged real-browser certification, and real-account certification remain excluded.

The current compatibility snapshot was tested on 2026-08-26 with Codex CLI `0.150.0-alpha.8`, Node.js `24.18.1`, Chrome Stable `151.0.7922.174`, and Windows x64. See [Compatibility](docs/compatibility.md) for the exact scope and limitations.

GPTSessionBridge is an independent project. It is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of their respective owner.

The architecture was informed by the MIT-licensed [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. GPTSessionBridge uses a different browser-session boundary and is being implemented clean-room unless a future notice states otherwise.

## License

[MIT](LICENSE)
