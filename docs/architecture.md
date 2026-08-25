# Architecture

## Context

GPTSessionBridge lets a Codex client create a thread backed by a ChatGPT Web model without moving the user's ChatGPT login into the bridge. It integrates at the Codex app-server boundary and uses a browser extension to operate only a tab the user explicitly connected.

## Components

### App-server facade

The facade is a bidirectional protocol proxy. It launches the official Codex app-server as a child process, correlates interleaved requests by identifier and direction, and forwards messages it does not own without changing their meaning.

The facade owns two operations:

1. Merge available Web models into paginated `model/list` results.
2. Pin the configured provider for Web-backed `thread/start`, `thread/resume`, and `thread/fork` requests.

Each browser capability snapshot has an opaque revision and lists the public reasoning efforts supported by each model. A Web turn pins the model, reasoning effort, and catalog revision together so a stale picker selection cannot be executed against a changed browser catalog.

Native Codex threads pass through without custom-provider routing. The bridge does not proxy native Codex API traffic.

### Local Responses adapter

The adapter presents the narrow Responses-compatible surface required by the Codex child for a Web-backed thread. It validates input, propagates cancellation, emits a terminal event exactly once, and translates between Responses streaming events and the versioned browser protocol.

### Native Messaging host

The host validates Chrome Native Messaging frames and relays only versioned, schema-checked messages. It does not expose browser cookies, storage, arbitrary JavaScript execution, or unrestricted DOM access to the bridge.

### Browser extension

The Manifest V3 extension connects a `chatgpt.com` tab only after an explicit user action. Its content adapter discovers public model labels, starts a turn, streams visible output, and reports session loss. DOM-specific behavior remains isolated from routing and protocol code.

## Dependency direction

```text
apps/bridge -----------+
apps/native-host ------+--> packages/core --> packages/protocol
apps/extension --------+           |
                                   +--> packages/responses
```

Applications own I/O and platform APIs. Packages contain portable contracts, state machines, and pure policy logic.

## Thread routing

Provider selection is pinned at a thread boundary. Web-to-Web model changes may be supported when the active Web adapter reports the capability. Switching between a native Codex provider and the Web provider requires a new thread or an explicit future handoff flow.

Unknown virtual model identifiers, stale model catalogs, disconnected tabs, and unsupported capabilities return explicit errors. They never trigger a provider or model fallback.

## Lifecycle

The facade follows a bounded lifecycle:

```text
spawning -> initializing -> ready -> draining -> exited
```

Writes are serialized per destination and respect backpressure. Malformed or oversized frames terminate the affected boundary safely. Child-process exit rejects outstanding work once and initiates an orderly shutdown.

## Persistence

The initial implementation keeps routing and conversation correlation in bounded memory. Persistent Web conversation state is out of scope until an encrypted, opt-in design is reviewed separately.
