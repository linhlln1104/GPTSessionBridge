# Architecture

## Context

GPTSessionBridge lets a Codex client create a thread backed by a ChatGPT Web model without moving the user's ChatGPT login into the bridge. It integrates at the Codex app-server boundary and uses a browser extension to operate only a tab the user explicitly connected.

Phase 2 implements the app-server facade, synthetic model catalog, thread routing, official Codex child lifecycle, and authenticated local Responses stub. Phase 3a implements the Native Messaging transport and relay state machine. The current Phase 3b increment adds authenticated Windows host-to-bridge IPC, `BrowserSessionCoordinator`, the Native Host runtime, and an explicit-tab Manifest V3 connection shell. Native-host packaging, the ChatGPT page adapter, and the Responses adapter remain future work. Consequently, a valid Web request currently terminates with `session_not_connected` rather than a simulated response.

## Components

### App-server facade

The implemented facade is a bidirectional protocol proxy. It launches the official Codex app-server as a child process, correlates interleaved requests by identifier and direction, and forwards messages it does not own without changing their meaning.

The facade owns two operations:

1. Merge the current synthetic Web model into paginated `model/list` results.
2. Pin the configured provider for verified Web-backed `thread/start`, `thread/resume`, and `thread/fork` requests.

Phase 2 uses a fixed synthetic catalog revision. `BrowserSessionCoordinator` already requires every browser capability snapshot to have an opaque revision and validates the selected model, reasoning effort, temporary-chat support, and revision before a turn starts. The page adapter currently reports an unavailable catalog, and the synthetic facade catalog is not yet replaced by coordinator state. A future Responses adapter must propagate the same pinned revision so a stale picker selection cannot execute against changed browser capabilities.

Native Codex threads pass through without custom-provider routing. The bridge does not proxy native Codex API traffic.

For a Web-backed thread, the facade removes request-local definitions of its reserved provider and injects the complete provider configuration itself. A fresh bearer capability and ephemeral loopback base URL are passed directly through the in-memory app-server request to the trusted official Codex child. They are not placed in the child environment, command-line arguments, logs, or persistent configuration.

### Local Responses provider boundary

The implemented Phase 2 stub presents the narrow authenticated endpoint required by the Codex child for a Web-backed thread. It binds only to an ephemeral IPv4 loopback port, validates the process capability, bounds request resources, accepts only `POST /v1/responses`, validates a JSON object body, and returns `session_not_connected`.

A later Phase 3 increment will replace the terminal stub behavior with a Responses adapter that propagates cancellation, emits a terminal event exactly once, and translates between Responses streaming events and the versioned browser protocol. It must receive the route's pinned `catalogRevision`; substituting the coordinator's latest revision would permit a stale selection and is therefore rejected by design.

Protocol v1 currently declares text input only and reports `toolCalls: false` and `imageInput: false`. A future adapter must reject unsupported Responses input explicitly; it must not discard tools, images, roles, or other semantics to force a browser turn through the narrower protocol.

### Native Messaging host

The Native Host runtime decodes Chrome's 4-byte length-prefixed UTF-8 JSON messages, applies a symmetric 1 MiB frame ceiling, bounds buffered and queued data, serializes writes with backpressure, and validates every frame against the versioned schema.

The host owns two independent protocol links: one to the extension and one to the bridge. It terminates handshakes, heartbeats, and acknowledgements locally; enforces exact peer, sequence, correlation, and direction rules; and re-envelopes application frames with a new link-local sequence. It never performs a blind byte relay.

The runtime validates one exact canonical Chrome extension origin before reading extension traffic. Only after the extension-side handshake is ready does it start the Windows IPC client. The bridge owns the deterministic pipe listener through a self-contained .NET helper implementing [ADR 0003](adr/0003-native-host-bridge-ipc.md); both helper processes mutually verify the peer's Windows user SID, logon SID, and session before relaying framed bytes. The bridge then initiates a fresh link handshake and attaches the authenticated application port to `BrowserSessionCoordinator`.

The source runtime is not yet packaged as a Chrome-launchable executable, registered in the Windows Native Messaging registry, installed, or signed. Those distribution steps remain a release gate rather than being simulated by a development script.

The deterministic pipe permits one Web-enabled facade per Windows logon session. Listener acquisition is an optional browser capability, not a prerequisite for the official Codex child: a missing helper, unsupported architecture, or already-owned pipe disables Web transport for that facade while native Codex traffic continues unchanged. Web requests still terminate at the bridge boundary and are never rerouted to native usage.

### Browser session coordinator

`BrowserSessionCoordinator` owns at most one authenticated browser transport and one active turn. It correlates session, capability, turn, and cancellation messages; freezes capability snapshots; rejects stale catalog revisions and unsupported options; serializes delta delivery through an asynchronous sink; bounds pending operations and timeouts; and settles every turn exactly once. It never replays a prompt after transport loss. A valid browser session disconnect causes the broker to discard the pipe and establish a fresh authenticated channel.

### Browser extension

The Manifest V3 shell connects only after the user presses Connect. The service worker queries the active tab itself, accepts only an exact `https://chatgpt.com` document, injects one isolated main-frame content probe under `activeTab`, binds the port to the returned `documentId`, and then opens the exact Native Messaging host. Disconnect invalidates the in-flight connection generation so a delayed tab query or injection cannot restore consent implicitly.

The extension has no persistent host access and no cookie, debugger, history, storage, or broad content-script permission. Its browser bundle uses a strict protocol parser and the build rejects dynamic-code constructs forbidden by the MV3 content security policy. The current content adapter deliberately reports `modelDiscovery: false` with an empty catalog and rejects turns. DOM-specific discovery and visible-page interaction remain isolated future work.

## Dependency direction

```text
Phase 2:

apps/bridge --> packages/core
       |
       +-----> packages/protocol

Phase 3:

apps/bridge -----------+----> packages/core
apps/native-host ------+----> packages/protocol
apps/browser-extension-+
                       +----> packages/native-messaging

Future Responses integration:

apps/bridge ----------------> packages/responses
```

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

The initial implementation keeps bridge-owned routing and conversation correlation in bounded memory. It cannot resume a Web route after the facade restarts. The official Codex child still owns its normal thread storage and may persist a rollout according to the request and Codex configuration. Additional persistent Web conversation state is out of scope until an encrypted, opt-in design is reviewed separately.
