# Compatibility

GPTSessionBridge relies on integration surfaces that can change independently: the Codex app-server protocol, the Codex IDE extension's executable override, Chrome Native Messaging, and the visible ChatGPT Web interface.

## Policy

- Support is declared for tested version ranges, not assumed from package names.
- Unknown protocol methods pass through unless the bridge explicitly owns them.
- Runtime schemas validate every owned boundary.
- Virtual-model collisions are rejected when the relevant native catalog page is observed.
- Versioned bridge-owned boundaries reject incompatible protocol revisions; the facade does not claim a startup compatibility gate for the upstream app-server protocol.
- Unsupported browser capabilities and stale model catalogs detected by the final pre-submit revalidation fail closed before composer mutation. Catalog changes after the synchronous Send click apply to future routes and do not replay or reroute the active owned turn.
- Development registration is ownership-checked, precedence-aware, and conservatively recoverable; it is not an atomic registry transaction.

The Codex app-server command and some transports are documented as experimental. See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server). The executable override used by IDE clients is a development setting, so each release must publish a tested compatibility matrix rather than promise unrestricted forward compatibility.

## Current matrix

No production compatibility is declared during pre-alpha development.

The following development snapshot was tested on 2026-08-26:

| Component        | Tested value      | Scope                                                               |
| ---------------- | ----------------- | ------------------------------------------------------------------- |
| Operating system | Windows x64       | Facade, Responses provider, pipe helper, SEA package, and setup CLI |
| Codex CLI        | `0.150.0-alpha.8` | Official `codex app-server` child                                   |
| Node.js          | `24.18.1`         | Workspace build, tests, facade, and smoke test                      |
| Google Chrome    | `151.0.7922.174`  | Direct production-driver DOM runtime against a synthetic local page |
| .NET SDK         | `10.0.301`        | Helper build, tests, formatting, audit, and single-file publish     |

Verified behavior in this snapshot:

- The facade starts the official Codex app-server over stdio and preserves unowned protocol messages.
- Native lifecycle requests remain semantic pass-through traffic. In particular, native `thread/resume` requests carrying inline history, an empty path, or a non-empty rollout path are forwarded unchanged; the stricter identity rules below apply only after a request resolves to a Web route.
- Native `model/list` pagination completes before models from one immutable coordinator snapshot are appended. With no connected tab, the Web catalog is empty.
- Selecting a dynamic public Web model rewrites it to an opaque provider token bound to the exact catalog revision without allowing model or provider fallback.
- Automated integration tests verify authenticated text Responses streaming and the activation-gated Web Agent Responses path, including non-stream output, bounded rejection, safe error mapping, stale-route invalidation, pending-workflow expiry, cumulative child continuations, replay rejection, and client-disconnect cancellation. The installed-Codex smoke covers the app-server handshake and disconnected catalog only.
- Windows integration tests verify one-instance pipe ownership, a logon-session DACL, remote-client rejection, mutual peer identity checks, bounded accept lifetime, and full-duplex framed relay.
- Synthetic tests verify the Native Messaging framing, strict origin policy, per-link handshake and sequence rules, direction-aware relay, coordinator correlation/lifecycle, bounded queues, and write backpressure.
- MV3 tests and build gates verify exact active-document selection, disconnect race handling, a strict sequenced browser-safe protocol, authenticated activation/status/activity/agent-turn handling, one-shot selected-document permits, adapter catalog/turn guards, a self-contained classic content bundle, and the absence of dynamic-code constructs in extension output. A separate Chrome Stable compatibility gate preflights and reports the browser version, requires major version 151 or newer, then runs the production DOM driver on a synthetic local document and exercises nested picker discovery/selection, final raw-picker drift, `InputEvent`, `MutationObserver`, visible-text filtering, text streaming, exact byte-preserving agent completion, owned `/` to `/c/...` adoption, unrelated-navigation rejection, and verified Stop cancellation.
- Protocol and bridge tests exercise the active v2 whole-response envelope codec, current-Codex initial and cumulative-continuation projection, certified closed-schema evaluation, canonical manifest binding, Responses lifecycle, agent runtime, coordinator integration, replay rejection, bounded rounds, and at-most-once commit. Extension fixtures cover disclosure, consent, expiry, activity renewal, selected-document binding, agent transport, and SPA-navigation invalidation. The official Codex child remains the execution/approval/sandbox authority; the bridge and browser code do not execute a proposed tool.
- Windows packaging verifies clean Node 24 SEA facade and Native Host executables, their adjacent self-contained helper, exact development manifest identity, complete artifact hashes, and absence of the local repository path. Its empty-environment smokes cover the packaged facade app-server handshake, disconnected catalog, native resume passthrough, and bidirectional Native Messaging relay.
- Setup tests cover bounded package traversal, links, case collisions, changed files, dual-view shadowing and shared-view convergence, ownership conflicts, detected read/write races, retained ambiguous state, status, and conservative unregister behavior without changing the machine registry.
- The opt-in Windows CI smoke verifies initially empty 32-bit and 64-bit HKCU development keys through install, status, and uninstall; it refuses to replace any pre-existing registration.

This matrix does not claim an end-to-end IDE coding flow, macOS, Linux, a packaged MV3/native-host Chrome E2E, a real-account turn, or stable ChatGPT Web compatibility. The direct Chrome gate is local and synthetic: it does not load the unpacked extension, contact ChatGPT, or use a browser profile. A read-only live UI audit on 2026-08-25 observed the semantic composer and direct/nested model-picker shapes used by the adapter, but it did not submit a prompt or select a model. Verification launches both packaged application executables directly: the facade through app-server stdio and the Native Host through Chrome-compatible argv and framing. It does not register either path through the browser during that smoke.

## Current restrictions

- Only the stdio app-server facade is owned by the bridge. Other Codex invocations pass through to the official executable.
- Client-supplied overrides for the reserved Web provider are rejected.
- Reserved model/provider values are rejected in app-server config writes and command-line overrides. Existing user-managed Codex configuration remains part of the trusted local boundary; lifecycle results that report the reserved namespace fail closed before a turn can start.
- Reviews, realtime sessions, and steering are rejected for Web-backed threads.
- Web `thread/resume` requests with inline history and Web resume/fork requests carrying a non-empty rollout path are rejected; an empty path is treated as absent by Codex.
- Web route metadata is process-local; the current MVP cannot resume a Web thread after the facade restarts.
- Effective `threadId` resume/fork sources remain quarantined until Codex returns a matching lifecycle identity. Native inline history and non-empty rollout paths validate and pin the actual returned identity instead. A mismatch terminates the facade session and requires the client to reconnect.
- Client notifications pass through the same thread and configuration guards as requests. Request-only lifecycle, initialization, and catalog operations are dropped when sent without an identifier.
- A Web model appears only while the selected tab has produced a valid coordinator capability snapshot. Reconnect the tab to refresh a changed visible catalog.
- Only one facade can own the deterministic browser IPC listener in a Windows logon session. Additional facades continue to support native Codex, but their Web route remains unavailable; no provider fallback occurs.
- The Native Host and unpacked extension are available only as an unsigned Windows x64 development package. Per-user setup uses the `.dev` host identity and a user-writable content-addressed directory; it is not a production installer or a Chrome Web Store distribution.
- The extension manifest's Chrome 106 minimum is the MV3/API floor, not a tested compatibility claim. The current synthetic DOM-runtime snapshot is certified only against Chrome Stable 151 or newer.
- Registry output decoding is tested for ASCII, UTF-8, and UTF-16LE. A non-ASCII local-app-data path emitted through an undecodable legacy Windows console code page fails closed and is not currently claimed as supported.
- The first adapter turn requires a fresh ChatGPT `/` surface with no visible transcript. The adapter never creates, clears, or navigates to a conversation on the user's behalf.
- Native protocol v1 supports user text and visible output text only. It advertises no image, temporary-chat, or tool-call capability; the Responses adapter rejects richer semantics rather than stripping or reinterpreting them.
- The nested model-picker path currently recognizes the English accessible submenu name `Model`. Localized ChatGPT picker variants have not been certified and remain unavailable when their semantics cannot be matched unambiguously.
- Disconnect teardown can only make a best-effort click on a currently visible, verified Stop control. If the selected document or transport is already gone, or the control has not appeared, the bridge cannot confirm that ChatGPT stopped generating; inspect the selected tab because generation and Web usage may continue.
- Normal Codex coding requests in the tested snapshot carry developer instructions and tool definitions and therefore fail closed on a text-v1 route. While the exact document-bound lease is active, selecting `Web Agent · …` instead routes the tested request projection through protocol v2. The projector retains only locally certifiable function tools, requires `exec_command`, rejects unsupported input semantics, disables parallel function calls, and binds cumulative child call/output history. It does not provide full Responses API equivalence.
- The bridge does not receive authoritative sandbox or approval-policy state in the admitted provider request and does not independently enforce a policy floor. The official Codex child and connected IDE client apply their configured policy and remain the only approval, sandbox, and execution authority.

## Browser UI changes

Phase 4 uses public, visible semantic UI state rather than undocumented backend model identifiers. Catalog identity is derived from normalized accessible descriptions and bound to a revision. Catalog or selected-model drift detected by the final pre-submit revalidation fails closed before composer mutation; composer write and Send click then execute synchronously. After that click, a new catalog affects future routes only. The active owned turn continues without replay or rerouting, but start-confirmation, ownership, or response-surface failure still terminates it. If the picker, composer, message stream, or selection state cannot be verified unambiguously, the associated Web model remains unavailable until the adapter is updated.
