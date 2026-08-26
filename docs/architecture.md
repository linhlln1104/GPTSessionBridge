# Architecture

## Context

GPTSessionBridge lets a Codex client create a thread backed by a ChatGPT Web model without moving the user's ChatGPT login into the bridge. It integrates at the Codex app-server boundary and uses a browser extension to operate only a tab the user explicitly connected.

Phase 2 implements the app-server facade, initial model-catalog routing, official Codex child lifecycle, and authenticated local Responses boundary. Phase 3 adds the Native Messaging relay, authenticated Windows host-to-bridge IPC, `BrowserSessionCoordinator`, explicit-tab Manifest V3 shell, and Windows development package. The current Phase 4 increment replaces the fixed Web fixture with the coordinator's dynamic visible-UI catalog and connects a strict text-only Responses adapter to a UI-only ChatGPT DOM adapter.

## Components

### App-server facade

The implemented facade is a bidirectional protocol proxy. It launches the official Codex app-server as a child process, correlates interleaved requests by identifier and direction, and forwards messages it does not own without changing their meaning.

The facade owns two operations:

1. Merge the current coordinator capability snapshot's Web models into paginated `model/list` results.
2. Pin the configured provider for verified Web-backed `thread/start`, `thread/resume`, and `thread/fork` requests.

`BrowserSessionCoordinator` requires every browser capability snapshot to have an opaque revision and validates the selected session, generation, model, reasoning effort, temporary-chat support, and revision before a turn starts. The facade gives each visible model a snapshot-bound public picker key and rewrites it to a separate opaque provider token. Both identities are derived from the selected session, snapshot generation, catalog revision, and browser model ID; neither reveals those inputs. They intentionally change after reconnect or catalog replacement so a stale picker selection becomes unavailable. The provider token is not a secret and is never published in `model/list`.

Native Codex threads pass through without custom-provider routing. The bridge does not proxy native Codex API traffic.

For a Web-backed thread, the facade removes request-local definitions of its reserved provider and injects the complete provider configuration itself. A fresh bearer capability and ephemeral loopback base URL are passed directly through the in-memory app-server request to the trusted official Codex child. They are not placed in the child environment, command-line arguments, logs, or persistent configuration.

The provider token exists only on the child-facing side of this boundary. Before a Web lifecycle response reaches the IDE, the facade rewrites the reported model to the pinned public picker key and rejects any remaining private route token, bearer capability, or loopback provider URL. Web lifecycle errors and child warnings containing the private route token are replaced with bounded, content-free compatibility errors or notices. Native lifecycle traffic remains unchanged.

### Local Responses provider boundary

The local provider presents the narrow authenticated endpoint required by the Codex child for a Web-backed thread. It binds only to an ephemeral IPv4 loopback port, validates the process capability and loopback request policy, bounds connections, headers, body, lifetime, and output, and accepts only `POST /v1/responses` with fatal UTF-8 and strict JSON validation.

Protocol v1 preserves bounded user text, visible output text, streaming, cancellation, one exact UI model choice, and no temporary-chat guarantee. The Responses parser therefore rejects tools, images, non-user roles, instructions, previous-response chaining, persistence, structured output, and unknown fields rather than dropping or reinterpreting them. Streaming emits a minimal Responses text lifecycle with serialized backpressure; client disconnect and output overflow cancel the browser turn. Browser errors are mapped to content-free local errors and never reflected verbatim.

This subset supports plain-text adapter turns but is not a complete Codex coding-agent provider. Normal Codex coding requests in the tested snapshot carry developer instructions and tool definitions and therefore fail closed at this boundary. Those semantics require a separate protocol decision; the bridge does not infer executable tool calls from prose.

### Native Messaging host

The Native Host runtime decodes Chrome's 4-byte length-prefixed UTF-8 JSON messages, applies a symmetric 1 MiB frame ceiling, bounds buffered and queued data, serializes writes with backpressure, and validates every frame against the versioned schema.

The host owns two independent protocol links: one to the extension and one to the bridge. It terminates handshakes, heartbeats, and acknowledgements locally; enforces exact peer, sequence, correlation, and direction rules; and re-envelopes application frames with a new link-local sequence. It never performs a blind byte relay.

The runtime validates one exact canonical Chrome extension origin before reading extension traffic. Only after the extension-side handshake is ready does it start the Windows IPC client. The bridge owns the deterministic pipe listener through a self-contained .NET helper implementing [ADR 0003](adr/0003-native-host-bridge-ipc.md); both helper processes mutually verify the peer's Windows user SID, logon SID, and session before relaying framed bytes. The bridge then initiates a fresh link handshake and attaches the authenticated application port to `BrowserSessionCoordinator`.

The Windows x64 development build bundles the TypeScript runtime into CommonJS, injects it into the pinned Node 24 executable using Node's Single Executable Application format, and places the self-contained IPC helper beside it. The artifact also contains the unpacked extension and a canonical manifest covering every file by size and SHA-256. Verification rejects extra files, links, case-colliding paths, traversal, changed content, local repository paths, and a development extension or Native Host manifest outside the exact package policy. A packaged-relay smoke starts the actual SEA executable and adjacent helper with empty environments from an empty temporary working directory and verifies framed traffic in both directions.

Per-user setup copies only a verified artifact into a content-addressed directory below local application data and generates a Chrome manifest with an absolute executable path. It inspects both HKCU Chrome Native Messaging registry views, refuses unmanaged or inconsistent values, reconciles the lower-precedence 64-bit view before the Chrome-effective 32-bit view, and verifies the final snapshot under the development-only `com.gptsessionbridge.native_host.dev` identity. Supported Windows versions share `HKCU\Software` across WOW64 views, so an exact target produced through one view may safely converge the other. `reg.exe` does not provide an atomic compare-and-swap, so different values and detected conflicts fail closed. Private staging is removed on failure, while promoted content-addressed artifacts are always retained because another concurrent installer may already have adopted them. Status and uninstall use the same ownership proof; uninstall clears 64-bit first, conditionally clears 32-bit if it remains, verifies both absent, and retains package files conservatively. Setup never mutates Chrome profiles or extension state.

This development flow is not a production installer. The artifact is unsigned and stored in a user-writable location, and automated verification does not claim real-Chrome or real-account compatibility. A protected per-machine install, code signing, release identities, and production-installer rollback remain release gates.

The deterministic pipe permits one Web-enabled facade per Windows logon session. Listener acquisition is an optional browser capability, not a prerequisite for the official Codex child: a missing helper, unsupported architecture, or already-owned pipe disables Web transport for that facade while native Codex traffic continues unchanged. Web requests still terminate at the bridge boundary and are never rerouted to native usage.

### Browser session coordinator

`BrowserSessionCoordinator` owns at most one authenticated browser transport and one active turn. It correlates session, capability, turn, and cancellation messages; freezes capability snapshots; rejects stale catalog revisions and unsupported options before start; serializes delta delivery through an asynchronous sink; bounds pending operations and timeouts; and settles every turn exactly once. It never replays a prompt after transport loss. A valid browser session disconnect causes the broker to discard the pipe and establish a fresh authenticated channel.

### Browser extension

The Manifest V3 extension connects only after the user presses Connect. The service worker queries the active tab itself, accepts only an exact `https://chatgpt.com` document, injects one isolated main-frame content script under `activeTab`, binds the port to the returned `documentId`, and then opens the exact Native Messaging host. Disconnect invalidates the in-flight connection generation so a delayed tab query or injection cannot restore consent implicitly.

The extension has no persistent host access and no cookie, debugger, history, storage, or broad content-script permission. Its self-contained classic content bundle uses a strict sequenced page protocol, and the build rejects module leakage and dynamic-code constructs forbidden by the MV3 content security policy.

The DOM driver operates ordinary visible controls using semantic roles, accessibility names, form relationships, and author-role message markers. Catalog discovery supports a direct picker and the observed nested submenu whose accessible name is the English word `Model`; localized submenu semantics remain unverified. Selection is confirmed by reopening the picker. A first turn requires a fresh `/` surface with no transcript; after submission, later turns remain bound to the first adapter-created user message and adopted conversation path. It never clicks New chat or navigates on the user's behalf. Assistant deltas come only from bounded visible text, and cancellation requires one verified stop control. Ambiguity or UI drift fails closed.

Catalog or selected-model drift detected by the final pre-submit revalidation fails the pending turn before composer mutation. The composer write and Send click then run synchronously. After that click, capability changes publish a new snapshot for future route resolution but do not replay, cancel, or reroute the active owned turn. The active turn continues against its submitted conversation only while start confirmation, the owned path, first adapter-created user message, and visible assistant surface remain valid; failure terminates it without automatic replay.

## Dependency direction

```text
apps/bridge -----------+----> packages/core
apps/native-host ------+----> packages/protocol
apps/browser-extension-+
                       +----> packages/native-messaging
apps/windows-setup ---------> Windows package and registry boundaries
```

The Responses adapter and DOM I/O remain application-owned because no other application consumes those platform boundaries.

Applications own I/O and platform APIs. Packages contain portable contracts, state machines, and pure policy logic.

## Thread routing

Provider selection is pinned at a thread boundary. Web-to-Web model changes may be supported when the active Web adapter reports the capability. Switching between a native Codex provider and the Web provider requires a new thread or an explicit future handoff flow.

Unknown virtual model identifiers, stale model catalogs, disconnected sessions, and unsupported capabilities return explicit errors. They never trigger a provider or model fallback.

Request-local definitions, config writes, and command-line overrides for the reserved Web provider or model namespace are rejected. Reviews, realtime sessions, steering, and unverified derived threads are rejected for Web routes. Web resumes that include inline history, plus Web resume or fork requests carrying any rollout path, are also rejected until the facade can establish a safe, unambiguous route identity for those forms.

During resume/fork, the source thread is quarantined: pipelined thread operations are rejected and server-initiated requests do not cross to the client until the lifecycle response settles. Resume responses must return the requested thread identifier; fork responses must return a fresh identifier with `thread.forkedFromId` bound to the requested source. Client notifications are subject to the same routing guards, while request-only lifecycle notifications are dropped because no response exists to validate their identity. A thread identifier returned with an invalid lifecycle result is retained as a bounded tombstone, and the proxy terminates so the official child cannot continue in an untrusted routing state.

## Lifecycle

The facade follows a bounded lifecycle:

```text
spawning -> initializing -> ready -> draining -> exited
```

Writes are serialized per destination and respect backpressure. Malformed or oversized frames terminate the affected boundary safely. Child-process exit rejects outstanding work once and initiates an orderly shutdown.

## Persistence

The implementation keeps bridge-owned routing and conversation correlation in bounded memory. It cannot resume a Web route after the facade restarts. The official Codex child still owns its normal thread storage and may persist a rollout according to the request and Codex configuration. ChatGPT may retain the visible conversation according to the user's account settings; the bridge neither persists nor deletes it. Additional bridge-owned persistent Web state is out of scope until an encrypted, opt-in design is reviewed separately.
