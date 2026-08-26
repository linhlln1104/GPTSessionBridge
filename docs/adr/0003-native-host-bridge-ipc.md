# ADR 0003: Authenticate Native Host-to-Bridge IPC with a Windows Named Pipe

- Status: Accepted
- Date: 2026-08-25
- Implementation: Windows x64 runtime, helper, and unsigned development package complete; protected production installation and signing remain separate release gates

## Context

Chrome starts a Native Messaging host as a separate process and gives it a stdio channel owned by Chrome. The Codex app-server facade is already running in another process. Those processes need a local rendezvous mechanism before an explicitly selected browser tab can serve a Web-backed turn.

The versioned `hello` frame proves protocol compatibility and peer intent; it does not authenticate a local process. A fixed loopback port, a discoverable bearer file, or reuse of the Responses bearer would either weaken the local trust boundary or persist a capability that is currently memory-only.

Chrome's Native Messaging manifest restricts which extension may start the host through an exact `allowed_origins` entry. The host also validates the caller origin, but that authenticates only the Chrome-facing link. It does not authenticate the bridge-facing link.

Node's named-pipe API does not expose the Windows primitives needed to set a logon-session DACL, reject remote clients, require first-instance ownership, or inspect the peer process token. The Windows transport therefore needs a small platform helper rather than a `node:net` listener.

## Decision

On Windows, the bridge and Native Messaging host communicate through a one-instance byte-mode named pipe owned by a .NET platform helper. The helper performs operating-system authentication before it relays any protocol bytes. The TypeScript processes continue to terminate framing, schemas, handshakes, sequence numbers, correlation, and application direction independently.

The authenticated principal is the current Windows logon session. This is intentionally narrower than “any local user” and more accurate than claiming executable identity.

### Pipe identity and ownership

The helper derives a deterministic, non-secret pipe name from a domain-separated hash of the protocol version and current logon SID. Neither the SID nor the resulting name is emitted in diagnostics. The name is discovery metadata, not an authentication capability.

The bridge helper creates the pipe with:

- `PIPE_ACCESS_DUPLEX`, `FILE_FLAG_OVERLAPPED`, and `FILE_FLAG_FIRST_PIPE_INSTANCE`;
- byte mode, blocking wait mode, `PIPE_REJECT_REMOTE_CLIENTS`, and one maximum instance;
- a protected DACL containing only the current logon SID;
- individual read, write, attribute, and synchronize rights rather than generic write access; and
- a non-inheritable pipe handle.

If the deterministic name is already owned, the bridge fails closed. It does not retry with a weaker transport or a random discoverable endpoint.

The client opens the same pipe with individual rights, overlapped I/O, and identification-only security quality of service. It does not retry through TCP or another fallback transport.

### Mutual operating-system verification

Immediately after connection and before relaying bytes, each helper obtains the peer PID and Windows session ID from the pipe handle. It opens and retains a handle to that process, reads the peer token, and compares all of the following with its own token:

- user SID;
- logon SID marked with `SE_GROUP_LOGON_ID`; and
- token session ID.

The pipe-reported session ID must also match the verified token session ID. Any missing token field, failed native call, exited peer, or mismatch closes the channel. Retaining the peer process handle prevents a later PID reuse from changing the identity that was checked.

### Fresh channel binding

The Native Messaging host may connect to the bridge only after it has validated Chrome's exact extension origin and completed the extension-side `hello` handshake. Chrome necessarily supplies the caller origin to the Native Messaging host as its first process argument. The host never forwards that origin, tab identity, or a challenge through the helper arguments, helper environment, pipe name, files, registry, or bridge protocol messages.

After the authenticated pipe connects, the bridge initiates a new bridge-link handshake with a cryptographically random request identifier. The host is the responder and must echo that identifier in `hello/acknowledged` before the deadline. Link-local sequence numbers begin at zero on every connection. A recorded acknowledgement from another connection therefore cannot complete the new handshake.

This challenge establishes freshness and binds protocol traffic to the live pipe; it is not a shared secret and does not replace the Windows identity checks.

### Helper and relay lifecycle

The bridge and Native Messaging host each spawn the packaged self-contained helper as a direct child with a fixed role argument, an empty inherited environment, and dedicated stdio pipes. The helper's mode is not secret. Its standard output carries only bounded length-framed relay bytes; standard error carries only allowlisted lifecycle/error codes. Content, identities, pipe names, nonces, and local paths are never logged.

The helper accepts one connection and one peer for its lifetime. It uses bounded buffers, serialized writes, cancellation-aware full-duplex copying, and a symmetric 1 MiB frame ceiling. EOF, peer exit, malformed framing, excess data, or either relay direction failing cancels the other direction and closes the pipe.

The Native Messaging host terminates transport frames independently on its Chrome and bridge links and re-envelopes validated application frames with link-local sequence numbers. It never performs a byte-for-byte relay between Chrome and the bridge. Application data is rejected when either destination link is unavailable; prompts are never queued for a future peer.

The Responses bearer remains confined to the official Codex child and local Responses endpoint. It is never used for pipe discovery or authentication.

## Trust boundary and limitations

This decision authenticates the Windows user and logon session, not the integrity of arbitrary user-writable JavaScript or the identity of an unsigned executable. Code already running as the same user in the same logon session can inspect the public pipe namespace, race the legitimate client, or imitate the protocol. Protecting against that attacker requires a separately installed and ACL-protected signed binary or a package identity backed by Windows, and is outside the initial local-user threat model.

Administrator, `SYSTEM`, kernel, browser-compromise, and same-logon-session malware are also outside this boundary. Races from those principals must still fail safely: the bridge must not fall back, disclose credentials, or silently submit a turn. Installation hardening and code signing are required before a production release and will be reviewed separately.

## Consequences

- Windows becomes the first supported end-to-end platform and requires the packaged .NET helper.
- At most one facade per Windows logon session owns browser IPC. Failure to acquire it disables the Web capability for that facade but does not terminate or reroute native Codex traffic.
- The TypeScript runtime cannot replace the helper with `node:net` without a new security review.
- A browser session is invalidated whenever the authenticated channel changes or disconnects. Active work terminates exactly once and is never replayed automatically.
- The app-server Responses boundary remains fail-closed until a separate adapter can preserve pinned session and catalog-revision identity without flattening unsupported Responses semantics. [ADR 0004](0004-ui-only-chatgpt-web-adapter.md) later accepts and implements that text-only adapter boundary.
- Unix-domain transport remains future work and must provide an equivalent documented identity and ownership boundary.

## Rejected alternatives

- A fixed or ephemeral unauthenticated TCP port.
- A plaintext discovery file containing a port, bearer, or challenge.
- Passing a shared secret through process arguments or inherited environment variables.
- Reusing the process-scoped Responses bearer outside the official Codex child boundary.
- Treating `hello(peer = "bridge")`, a parent PID, or a parent window handle as authentication.
- Using a public nonce as an HMAC key or otherwise presenting an unkeyed transcript hash as identity proof.
- Relying on the default named-pipe DACL or `PipeOptions.CurrentUserOnly` as the complete boundary.

## References

- [Named Pipe Security and Access Rights](https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights)
- [CreateNamedPipe](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createnamedpipew)
- [GetNamedPipeClientProcessId](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)
