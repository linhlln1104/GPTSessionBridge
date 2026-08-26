# Security Policy

GPTSessionBridge is pre-alpha and has not received an independent security audit. The facade, authenticated Windows IPC, browser-session coordinator, Native Messaging runtime, UI-only explicit-tab adapter, strict text-only Responses integration, direct synthetic Chrome DOM fixture, and unsigned per-user Windows development package are implemented. Protocol v2 currently consists only of an accepted activation-gated design and an isolated strict envelope codec. Protected production installation, code signing, Codex tool-call runtime support, packaged-extension E2E, and real-account certification are not implemented. The `main` branch is the only supported development line. No release should be treated as production-ready until this policy explicitly says otherwise.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository when it is available. If it is unavailable, open a minimal issue asking the maintainer to establish a private contact channel; do not include exploit details, credentials, account data, or user content in that issue.

Include only the minimum synthetic reproduction needed to understand the problem. Never attach a real browser profile, HAR file, cookie, token, prompt, response, source tree, or diagnostic archive.

## Security invariants

- ChatGPT session credentials remain inside the user's browser.
- Codex credentials remain under the official Codex client's authentication flow.
- The browser extension connects only after an explicit user action and revalidates the selected tab and document across asynchronous browser operations.
- Browser permissions are limited to `activeTab`, `scripting`, and `nativeMessaging`; there are no persistent host, cookie, debugger, history, or storage permissions.
- The page adapter uses visible DOM and accessibility semantics only. It does not read browser storage or page JavaScript state and does not call ChatGPT backend endpoints.
- A first turn requires a fresh `/` conversation with no transcript. Later turns remain bound to the first adapter-submitted user message and adopted conversation path; the adapter never navigates or submits into an arbitrary existing chat.
- Model discovery derives public descriptors from visible picker semantics. Provider tokens are opaque, contain no credential, and resolve only against the coordinator's current exact catalog revision.
- Catalog or selected-model drift detected by the final pre-submit revalidation fails closed before composer mutation. The composer write and Send click then execute synchronously. Once that click is issued, a later catalog snapshot applies only to future routes; it does not replay, cancel, or reroute the active owned turn. Conversation-ownership, start-confirmation, or visible-surface failure still fails that active turn without automatic replay.
- Disconnect teardown makes only a best-effort cancellation request through a currently visible, verified Stop control. If the document or transport is already unavailable, or the control has not appeared, the bridge cannot confirm that ChatGPT stopped generating; generation and Web usage may continue until the user checks the selected tab.
- The Native Messaging host accepts one exact canonical extension origin; wildcard origins are rejected.
- Development registration uses the separate `com.gptsessionbridge.native_host.dev` HKCU identity so it cannot shadow a future production host name. Setup accepts no caller-supplied extension identity or host name.
- The development installer verifies a complete content-hash manifest, rejects links and path traversal, copies into a content-addressed user-local directory, refuses unmanaged ownership in either Chrome registry view, and registers only after the package and generated Chrome manifest are verified.
- Development setup reconciles the lower-precedence 64-bit view before the Chrome-effective 32-bit view and verifies both final values. Supported Windows versions share `HKCU\Software` across views, so an exact-path change in one view may safely converge the other; foreign or different values still fail closed.
- Registry commands are not atomic; detected conflicts fail closed, private staging is removed, and promoted content-addressed artifacts are always retained because another installer may already have adopted them.
- Development uninstall verifies both views, clears 64-bit first, conditionally clears 32-bit if it remains, verifies both absent, and retains content-addressed files. It never edits Chrome profiles or extension state.
- Native Messaging frames are schema-checked, direction-checked, sequence-checked, and limited to 1 MiB on both links.
- Transport frames terminate at the native host. Relayed application frames receive a new link-local sequence.
- A protocol `hello` is never accepted as proof of local-process identity.
- Bridge-to-host IPC uses the accepted Windows named-pipe design in ADR 0003: protected logon-SID DACL, first-instance ownership, remote-client rejection, one pipe instance, and mutual user/logon/session verification before bytes are relayed.
- The bridge initiates a fresh random link handshake on every authenticated pipe; prompts are not queued for a future browser peer.
- The Windows helper is a self-contained child with a fixed role argument and an empty inherited environment. Pipe names, SIDs, challenges, content, and credentials are never accepted through or emitted to those channels.
- Local network listeners bind only to loopback and require a process-scoped capability.
- The capability is generated per facade process, kept only in process memory, and never placed in child environment variables, command-line arguments, logs, or persistent configuration.
- The capability is injected directly into the in-memory app-server configuration sent to the official Codex child for a Web-backed thread. The official Codex child is therefore inside the trusted boundary.
- Protocol mismatches, disconnected sessions, and unavailable models fail closed.
- The Responses endpoint accepts exactly one bounded user text item preserved by browser protocol v1. Multiple messages or parts, tools, images, instructions, non-user roles, structured output, chaining, and persistence requests are rejected rather than joined, removed, or reinterpreted.
- Protocol v2 schemas and its visible-envelope codec are not part of the active Native Messaging or Responses unions. Protocol v1 continues to advertise `toolCalls: false`, and no Web Agent model is published.
- A future v2 assistant envelope is an untrusted model proposal. Its round challenge can reject stale, cross-round, or replayed output, but it cannot authenticate the model response or prevent prompt injection because the challenge is visible to the model.
- Tool execution, approval, and sandbox authority must remain with the official Codex child. The bridge must not execute a parsed proposal, answer an approval request, or weaken the configured sandbox floor itself.
- Provider selection never falls back silently.
- Failure to acquire the optional browser IPC listener does not disable native Codex traffic; Web routes remain unavailable and are never redirected to Codex usage.
- Client-supplied definitions and persistent config writes for the reserved Web provider or model namespace are rejected instead of merged or trusted.
- Reviews, realtime sessions, steering, unverified derived threads, and `thread/resume` or `thread/fork` requests carrying a rollout path fail closed for Web routes until their routing identity can be verified safely.
- Resume/fork sources are quarantined until their lifecycle identity is validated; server requests and pipelined thread operations cannot cross that boundary. Lifecycle notifications without a request identifier are dropped because they cannot be correlated with a validating response.
- Web lifecycle results expose only the pinned public model key. Any residual private route token, bearer capability, or loopback provider URL fails closed; Web lifecycle errors and child warnings containing the private route token are replaced with content-free bridge messages.
- A successful resume must return the requested thread identifier. A successful fork must return a new thread identifier and name the requested source in `thread.forkedFromId`.
- A thread identifier returned with an invalid lifecycle identity is tombstoned in bounded memory and the facade session terminates, preventing continued execution in an untrusted routing state.
- Runtime diagnostics exclude prompts, responses, browser content, paths, configuration payloads, and credentials. The interactive setup CLI returns only the installed artifact paths required to load or inspect the development package.
- The bridge does not add persistent storage for Web route metadata or conversation content, and telemetry is disabled by default. The official Codex child remains responsible for its normal thread storage according to the request and Codex configuration.

In the current runtime, a supported plain-text Responses request can reach the explicitly selected ChatGPT tab and stream visible assistant text. A request without a connected tab returns `session_not_connected`; stale catalogs and unsupported semantics return explicit errors. Normal Codex coding requests include developer or tool semantics outside this text-only contract and fail closed. The v2 codec cannot be reached from that path. The facade must not simulate tool calls, select another model, replay a prompt, or route the request to native Codex.

The unsigned development package is writable by the current user and does not establish executable identity against another process already running as that user. Same-user registry mutation cannot be made transactional through `reg.exe` and remains outside this trust boundary. Production distribution requires a protected installation location, reserved release extension/host identities, code signing, and a separately reviewed installer.

See [docs/security-model.md](docs/security-model.md) for the threat model.
