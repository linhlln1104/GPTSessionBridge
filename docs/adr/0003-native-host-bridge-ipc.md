# ADR 0003: Authenticate Native Host-to-Bridge IPC Before Runtime Wiring

- Status: Proposed
- Date: 2026-08-25

## Context

Chrome starts a Native Messaging host as a separate process and gives it a stdio channel owned by Chrome. The Codex app-server facade is already running in another process. Those processes therefore need a local rendezvous mechanism before a selected browser tab can serve a Web-backed turn.

The versioned `hello` frame proves protocol compatibility and peer intent; it does not authenticate a local process. A fixed loopback port, a discoverable token file, or reuse of the Responses bearer would let another local process cross trust boundaries or would persist a capability that is currently memory-only.

Chrome's Native Messaging manifest already restricts which extension may start the host through an exact `allowed_origins` entry. The host must verify the caller origin again, but that check authenticates the Chrome-facing link only. It does not authenticate the bridge-facing link.

## Proposed requirements

The production rendezvous design must satisfy all of the following before it is wired into the native-host executable or browser extension:

1. Use an operating-system-local, user-scoped transport, such as a Windows named pipe or Unix domain socket with restrictive ownership.
2. Establish single-owner semantics and reject a second bridge or host when identity is ambiguous.
3. Bind a fresh challenge to the current bridge process and the user-approved extension connection. Prevent replay across reconnects.
4. Keep rendezvous capabilities out of files, registry values, environment variables, command-line arguments, diagnostics, and browser messages.
5. Keep the Responses bearer separate from Native Messaging and IPC authentication.
6. Enforce the same schema, frame, sequence, queue, timeout, and direction limits on both protocol links.
7. Drop application data when the destination link is unavailable; never queue a prompt while waiting for an unverified peer.
8. Treat a `hello(peer = "bridge")` frame as negotiation only, not authentication.

The host terminates transport frames independently on each link and re-envelopes validated application frames with a link-local sequence. It never performs a byte-for-byte blind relay.

## Phase 3a consequence

Phase 3a implements the bounded Native Messaging codec, exact extension-origin policy, link state machine, and direction-aware relay in isolation. It deliberately does not ship a native-host manifest, registration script, broker listener, or extension connection until this ADR is resolved with a tested platform implementation.

The app-server facade continues to return `session_not_connected`; there is no simulated Web response or provider fallback.

## Rejected interim shortcuts

- A fixed unauthenticated TCP port.
- A plaintext discovery file containing a port or bearer token.
- Passing a shared secret through process arguments or inherited environment variables.
- Reusing the process-scoped Responses bearer outside the official Codex child boundary.
- Trusting the protocol peer role or Windows parent-window handle as authentication.

## References

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)
