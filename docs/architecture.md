# Architecture

## Context

GPTSessionBridge lets a Codex client create a thread backed by a ChatGPT Web model without moving the user's ChatGPT login into the bridge. It integrates at the Codex app-server boundary and uses a browser extension to operate only a tab the user explicitly connected.

Phase 2 implements the app-server facade, synthetic model catalog, thread routing, official Codex child lifecycle, and authenticated local Responses stub. Phase 3a implements the isolated Native Messaging transport and relay state machine. Authenticated host-to-bridge IPC, the browser extension, and the Responses adapter remain future work. Consequently, a valid Web request currently terminates with `session_not_connected` rather than a simulated response.

## Components

### App-server facade

The implemented facade is a bidirectional protocol proxy. It launches the official Codex app-server as a child process, correlates interleaved requests by identifier and direction, and forwards messages it does not own without changing their meaning.

The facade owns two operations:

1. Merge the current synthetic Web model into paginated `model/list` results.
2. Pin the configured provider for verified Web-backed `thread/start`, `thread/resume`, and `thread/fork` requests.

Phase 2 uses a fixed synthetic catalog revision. In Phase 3, each browser capability snapshot will have an opaque revision and list the public reasoning efforts supported by each model. A Web turn pins the model, reasoning effort, and catalog revision together so a stale picker selection cannot be executed against a changed browser catalog.

Native Codex threads pass through without custom-provider routing. The bridge does not proxy native Codex API traffic.

For a Web-backed thread, the facade removes request-local definitions of its reserved provider and injects the complete provider configuration itself. A fresh bearer capability and ephemeral loopback base URL are passed directly through the in-memory app-server request to the trusted official Codex child. They are not placed in the child environment, command-line arguments, logs, or persistent configuration.

### Local Responses provider boundary

The implemented Phase 2 stub presents the narrow authenticated endpoint required by the Codex child for a Web-backed thread. It binds only to an ephemeral IPv4 loopback port, validates the process capability, bounds request resources, accepts only `POST /v1/responses`, validates a JSON object body, and returns `session_not_connected`.

Phase 3 will replace the terminal stub behavior with a Responses adapter that propagates cancellation, emits a terminal event exactly once, and translates between Responses streaming events and the versioned browser protocol.

Protocol v1 currently declares text input only and reports `toolCalls: false` and `imageInput: false`. A future adapter must reject unsupported Responses input explicitly; it must not discard tools, images, roles, or other semantics to force a browser turn through the narrower protocol.

### Native Messaging host

Phase 3a implements the host's transport foundation. It decodes Chrome's 4-byte length-prefixed UTF-8 JSON messages, applies a symmetric 1 MiB frame ceiling, bounds buffered and queued data, serializes writes with backpressure, and validates every frame against the versioned schema.

The host owns two independent protocol links: one to the extension and one to the bridge. It terminates handshakes, heartbeats, and acknowledgements locally; enforces exact peer, sequence, correlation, and direction rules; and re-envelopes application frames with a new link-local sequence. It never performs a blind byte relay.

The foundation also validates one exact canonical Chrome extension origin. A runnable host, Chrome registration, and bridge-facing IPC are intentionally withheld until [ADR 0003](adr/0003-native-host-bridge-ipc.md) defines an authenticated rendezvous. The host will not expose browser cookies, storage, arbitrary JavaScript execution, or unrestricted DOM access to the bridge.

### Browser extension

Planned for Phase 3. The Manifest V3 extension will connect a `chatgpt.com` tab only after an explicit user action. Its content adapter will discover public model labels, start a turn, stream visible output, and report session loss. DOM-specific behavior will remain isolated from routing and protocol code.

## Dependency direction

```text
Phase 2:

apps/bridge --> packages/core
       |
       +-----> packages/protocol

Phase 3a:

apps/native-host ----------> packages/protocol

Future Phase 3:

apps/bridge ----------+----> packages/core
apps/native-host -----+----> packages/protocol
apps/extension -------+
                      +----> packages/responses
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
