# Compatibility

GPTSessionBridge relies on integration surfaces that can change independently: the Codex app-server protocol, the Codex IDE extension's executable override, Chrome Native Messaging, and the visible ChatGPT Web interface.

## Policy

- Support is declared for tested version ranges, not assumed from package names.
- Unknown protocol methods pass through unless the bridge explicitly owns them.
- Runtime schemas validate every owned boundary.
- Virtual-model collisions are rejected when the relevant native catalog page is observed.
- Versioned bridge-owned boundaries reject incompatible protocol revisions; the facade does not claim a startup compatibility gate for the upstream app-server protocol.
- Unsupported browser capabilities and stale model catalogs fail closed.
- Development registration is ownership-checked, precedence-aware, and conservatively recoverable; it is not an atomic registry transaction.

The Codex app-server command and some transports are documented as experimental. See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server). The executable override used by IDE clients is a development setting, so each release must publish a tested compatibility matrix rather than promise unrestricted forward compatibility.

## Current matrix

No production compatibility is declared during pre-alpha development.

The following development snapshot was tested on 2026-08-25:

| Component        | Tested value        | Scope                                                           |
| ---------------- | ------------------- | --------------------------------------------------------------- |
| Operating system | Windows x64         | Facade, Responses stub, pipe helper, SEA package, and setup CLI |
| Codex CLI        | `0.149.0-alpha.4.3` | Official `codex app-server` child                               |
| Node.js          | `24.18.1`           | Workspace build, tests, facade, and smoke test                  |
| .NET SDK         | `10.0.301`          | Helper build, tests, formatting, audit, and single-file publish |

Verified behavior in this snapshot:

- The facade starts the official Codex app-server over stdio and preserves unowned protocol messages.
- Native `model/list` pagination completes before the synthetic `gptsessionbridge/web/example-model` entry is appended.
- Selecting the synthetic model pins the reserved local provider without allowing model or provider fallback.
- Automated integration tests verify that a valid request reaches the authenticated loopback Responses endpoint and returns `session_not_connected`, which is the expected Phase 2 result. The installed-Codex smoke test covers the app-server handshake and model catalog only.
- Windows integration tests verify one-instance pipe ownership, a logon-session DACL, remote-client rejection, mutual peer identity checks, bounded accept lifetime, and full-duplex framed relay.
- Synthetic tests verify the Native Messaging framing, strict origin policy, per-link handshake and sequence rules, direction-aware relay, coordinator correlation/lifecycle, bounded queues, and write backpressure.
- MV3 tests and build gates verify exact active-document selection, disconnect race handling, a strict browser-safe protocol parser, and the absence of dynamic-code constructs in the extension output.
- Windows packaging verifies a clean Node 24 SEA Native Host, adjacent self-contained helper, exact development manifest identity, complete artifact hashes, absence of the local repository path, and a bidirectional packaged-relay smoke with empty child environments.
- Setup tests cover bounded package traversal, links, case collisions, changed files, dual-view shadowing and shared-view convergence, ownership conflicts, detected read/write races, retained ambiguous state, status, and conservative unregister behavior without changing the machine registry.
- The opt-in Windows CI smoke verifies initially empty 32-bit and 64-bit HKCU development keys through install, status, and uninstall; it refuses to replace any pre-existing registration.

This matrix does not claim IDE-extension, macOS, Linux, automated real-Chrome launch, real-account, or ChatGPT Web compatibility. Verification launches the packaged Native Host directly through Chrome-compatible argv and framing but does not register it or start Chrome. The synthetic model is a development fixture, not a supported model route.

## Current restrictions

- Only the stdio app-server facade is owned by the bridge. Other Codex invocations pass through to the official executable.
- Client-supplied overrides for the reserved Web provider are rejected.
- Reserved model/provider values are rejected in app-server config writes and command-line overrides. Existing user-managed Codex configuration remains part of the trusted local boundary; lifecycle results that report the reserved namespace fail closed before a turn can start.
- Reviews, realtime sessions, and steering are rejected for Web-backed threads.
- Web `thread/resume` requests with inline history and Web resume/fork requests carrying any rollout path are rejected.
- Web route metadata is process-local; resuming a Web thread after restarting the facade is not supported in Phase 2.
- Resume/fork sources remain quarantined until Codex returns a matching lifecycle identity. A mismatch terminates the facade session and requires the client to reconnect.
- Client notifications pass through the same thread and configuration guards as requests. Request-only lifecycle, initialization, and catalog operations are dropped when sent without an identifier.
- The local provider is not connected to `BrowserSessionCoordinator` and therefore returns `session_not_connected` even if the authenticated IPC listener is running.
- Only one facade can own the deterministic browser IPC listener in a Windows logon session. Additional facades continue to support native Codex, but their Web route remains unavailable; no provider fallback occurs.
- The Native Host and unpacked extension are available only as an unsigned Windows x64 development package. Per-user setup uses the `.dev` host identity and a user-writable content-addressed directory; it is not a production installer or a Chrome Web Store distribution.
- Registry output decoding is tested for ASCII, UTF-8, and UTF-16LE. A non-ASCII local-app-data path emitted through an undecodable legacy Windows console code page fails closed and is not currently claimed as supported.
- The extension connection shell has no ChatGPT DOM adapter. It advertises an unavailable catalog and rejects every turn without touching credentials or undocumented backend endpoints.
- Native protocol v1 supports text input only and advertises no image or tool-call capability. A future Responses adapter must reject richer input rather than strip or reinterpret it.

## Browser UI changes

Phase 3 will use public, visible UI state rather than undocumented backend model identifiers. A browser adapter revision will report its capabilities to the bridge; if required semantics cannot be verified, the associated Web model will remain unavailable until the adapter is updated.
