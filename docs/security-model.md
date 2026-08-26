# Security Model

## Assets

GPTSessionBridge protects:

- ChatGPT and Codex authentication material;
- prompts, responses, source code, tool input, and tool output;
- the integrity of model/provider selection;
- the integrity of local tool approvals and cancellation;
- browser and local-machine boundaries.

## Trust boundaries

### Codex boundary

The official Codex app-server owns Codex authentication, thread state, approvals, and sandbox behavior. The facade handles protocol envelopes but must not request, copy, or log Codex credentials.

The facade launches the official Codex app-server as a child process. That child receives the Web provider configuration and its process-scoped capability over the in-memory app-server protocol, so the official child is part of the trusted computing boundary. The capability is not inherited through the child environment, exposed on the command line, logged, or written to a persistent configuration file.

### Browser boundary

The ChatGPT session remains in Chrome. The Manifest V3 extension connects only a user-selected active `https://chatgpt.com` document and exchanges strictly parsed messages with an isolated content adapter. It has `activeTab`, `scripting`, and `nativeMessaging`, but no persistent host, cookie, debugger, history, storage, or browser-profile access. The adapter uses visible DOM and accessibility semantics; it does not inspect page JavaScript state or issue ChatGPT network requests.

Before its first turn, the adapter requires a fresh `/` conversation with an empty transcript and composer. It then binds later turns to the first user message it submitted and the adopted conversation path. Catalog or selected-model drift detected by the final pre-submit revalidation fails closed before composer mutation; composer write and Send click then run synchronously. After that click, a new catalog is used only for future routes and does not replay, cancel, or reroute the active owned turn. Start-confirmation failure, navigation, DOM ownership loss, ambiguous response surfaces, or unverifiable model selection still fails the affected turn without automatic replay. The visible ChatGPT conversation may be retained by ChatGPT under the user's account settings.

On disconnect or teardown, the adapter requests cancellation only through a currently visible, verified Stop control. This is best-effort: after document or transport loss, or before the control becomes visible, the bridge cannot prove that the remote generation stopped. The user must inspect the selected tab when that distinction matters; generation and Web usage may continue outside the bridge's observable state.

The direct picker is discovered through visible semantics. The observed nested picker currently depends on the English accessible submenu name `Model`; localized variants are not certified and fail unavailable if they cannot be matched unambiguously.

### Local transport boundary

The Responses boundary binds to an ephemeral port on `127.0.0.1`, authenticates with a high-entropy process capability, and limits headers, body size, connections, requests per socket, request lifetime, and output size. It resolves opaque provider model tokens only against the coordinator's current catalog snapshot and forwards the exact catalog revision and visible-UI model identity. A `text-v1` route accepts a strict user-text subset. An activation-gated `agent-v2` route uses a separate current-Codex projector, certified closed-schema function profile, bounded pending-workflow registry, and exact cumulative continuation binding. Unsupported semantics fail closed rather than being flattened into prose.

The Native Messaging runtime enforces an exact extension-origin allowlist, a symmetric 1 MiB frame ceiling, bounded queues, strict schemas, independent link-local sequences, and direction-specific application messages. Protocol `hello` frames are negotiation and are not treated as local-process authentication.

On Windows, [ADR 0003](adr/0003-native-host-bridge-ipc.md) is implemented by a self-contained helper on each side of a one-instance named pipe. The server uses a protected logon-SID DACL, granular rights, first-instance ownership, and remote-client rejection. Before relaying bytes, both sides compare the pipe peer's PID/session with a retained process handle and token user SID, logon SID, and session ID. The bridge then initiates a fresh random link handshake. The pipe name and challenge are public freshness/discovery metadata, not bearer credentials.

This authenticates the Windows user and logon session, not executable integrity. Same-user code already running in the same logon session, administrators, `SYSTEM`, kernel compromise, and browser compromise remain outside this boundary. The development SEA package and content hashes detect post-manifest mutation and copy corruption, not a compromised or incorrect build; they are not a signature or a protected installation identity. ACL-protected installation and signing remain required before production distribution.

### Web Agent boundary

Protocol v2 is connected through the authenticated Responses listener, browser coordinator, Native Messaging/page protocol v2, one-shot selected-document permit, and exact DOM-agent response path. The coordinator binds the canonical request and cumulative child history, certified serial tool manifest, selected browser document, route, child request metadata, workflow round, and one pending function call; a committed call is never replayed. These checks do not authorize or execute a tool. Approval, sandbox, and execution authority remains exclusively in the official Codex child.

The extension exposes a separate memory-only consent lease for the exact selected tab and document. It starts only after an explicit disclosure gesture, expires after 15 minutes without admitted agent activity, and is invalidated by unrelated navigation, document replacement, disconnect, extension restart, or explicit deactivation. Connecting a text-only tab, opening the popup, or reading status does not activate or renew it. A `Web Agent · …` entry is published only while the authenticated active snapshot matches the selected session and document. The separate text capability continues to report `toolCalls: false`; that field is not used as v2 authorization.

The bridge does not receive authoritative sandbox or approval-policy state in the provider request and therefore does not claim to enforce a second policy floor. It cannot answer an approval request or execute a proposal. Users retain the official Codex child's configured policy, and a proposal becomes local activity only through that child's normal function-call lifecycle.

### Development setup boundary

The Windows development package uses a host name ending in `.dev`, separate from any future production registration. Its manifest pins the exact public development extension origin. Per-user setup verifies the complete package manifest, rejects links and path escape, copies to a content-addressed directory below local application data, and materializes an absolute executable path. It inspects both HKCU Chrome Native Messaging views, rejects foreign or inconsistent ownership, reconciles 64-bit before Chrome's higher-precedence 32-bit view, and verifies both final paths. Because supported Windows versions share `HKCU\Software` across WOW64 views, an exact target written through one view may legitimately satisfy the other and is treated as safe convergence.

Those `reg.exe` read/write steps are deliberately treated as non-atomic. A detected conflict fails closed. Setup removes only private staging on failure and always retains promoted package and registration artifacts rather than risking removal of paths another successful invocation has already adopted. Uninstall clears 64-bit first, conditionally clears 32-bit if the shared-view operation did not already do so, verifies both absent, and deliberately retains package files. Setup never edits Chrome profiles, loads or removes extensions, or starts a browser. Because the package remains user-writable and unsigned, these controls provide reversible development setup and corruption detection, not defense against same-user code execution or concurrent registry mutation by that user.

The capability lifecycle is:

1. The facade generates a fresh capability when its process starts.
2. The local Responses endpoint binds to an ephemeral loopback port.
3. For a Web-backed thread, the facade injects the endpoint and capability directly into the request's in-memory app-server configuration.
4. The trusted Codex child uses that configuration for the local Responses request.
5. The endpoint validates the loopback request and bearer capability before reading the bounded JSON body.
6. The endpoint resolves the opaque provider model only against the current coordinator snapshot, then starts a turn with the pinned `catalogRevision`, model, and reasoning choice.
7. The selected document performs a final catalog/model revalidation and synchronously writes and submits bounded visible text. A text turn streams bounded assistant text; an agent turn buffers exact bounded visible text for whole-envelope validation. Later catalog updates affect future routes only, while start-confirmation, ownership, or response-surface failure terminates the active turn without replay.
8. The endpoint closes and the capability becomes unusable when the facade exits.

## Threats and controls

| Threat                      | Required control                                                                 |
| --------------------------- | -------------------------------------------------------------------------------- |
| Credential extraction       | No cookie/debugger permissions; no credential fields in protocols or logs        |
| Local process impersonation | Responses capability; logon-SID pipe DACL and mutual peer-token verification     |
| Extension impersonation     | Pinned extension identity, exact allowlist, and runtime caller-origin check      |
| Development host collision  | Separate `.dev` identity; refuse unmanaged HKCU registry ownership               |
| Package corruption          | Complete SHA-256/size manifest; reject extra files, links, and path escape       |
| Prompt or response leakage  | Memory-only processing; content-free diagnostics; synthetic fixtures             |
| Provider confusion          | Pin the provider, model, reasoning effort, and catalog revision per thread       |
| Silent quota crossover      | Explicit errors; no automatic Codex/Web fallback                                 |
| Duplicate submission        | Link-local sequence validation; coordinator enforces one terminal event          |
| Unbounded input             | Frame-size, queue, timeout, and concurrency limits                               |
| UI drift                    | Semantic verification, revision-bound catalog, fresh-chat ownership, fail closed |
| Capability disclosure       | Memory-only token; no child environment, arguments, logs, or disk config         |
| Provider override injection | Reject reserved request, config-write, and command-line overrides                |
| Ambiguous thread identity   | Reject Web review/realtime flows and unsupported history or path identities      |

The text-only Responses contract accepts exactly one user text item. It does not accept multiple messages or parts, developer-role input, instructions, tool definitions, or tool calls. Normal Codex coding requests in the tested snapshot include unsupported semantics and therefore fail closed on that route rather than being joined or flattened into user prose. The separately selected Web Agent route projects only the tested developer/user text and locally certifiable function tools into a visible compatibility prompt; this projection does not preserve native role priority or full Responses semantics.

## Diagnostics

Production runtime diagnostics use an allowlisted event schema. They may contain a component name, event name, opaque correlation identifier, status, duration, and byte counts. They must not contain arbitrary request parameters, results, prompts, responses, configuration objects, browser content, credentials, account identifiers, or paths. The interactive development setup CLI separately returns the installed executable, manifest, and unpacked-extension paths required for local operation; it never returns browser or account data.

Debug mode does not relax these rules. A future support bundle must be opt-in, time-limited, scrubbed, and previewable before export.

## Routing constraints

The facade owns the reserved Web provider definition. A client cannot replace its base URL, capability, retry policy, or authentication flags through request-local provider configuration. Web routes disable provider fallback and pin the selected public model, provider model, reasoning effort, and catalog revision to the thread. Reserved model/provider values are also rejected in app-server config writes and command-line overrides.

Derived Web threads are accepted only when the facade can verify and pin their route. Reviews, realtime sessions, and steering are rejected for Web threads because their execution identity cannot yet be bound safely. A Web `thread/resume` request with inline history, or a Web resume/fork request carrying a non-empty rollout path, is also rejected because the current process-local routing design cannot prove that the supplied identity belongs to the pinned route. Codex defines an empty path as absent, so it remains bound to `threadId`. These guards run only for Web routes; native lifecycle parameters pass through unchanged.

Resume/fork sources are quarantined until the lifecycle response is validated. During that window, pipelined thread operations are rejected, server-initiated requests receive an error, and client responses to server requests are dropped. If a lifecycle response returns a mismatched model, provider, or thread identity, the facade records a bounded tombstone and terminates the proxy session.

The opaque provider model token is confined to the child-facing route. Successful Web lifecycle responses are rewritten to the pinned public picker key and recursively checked for any residual private route token, bearer capability, or loopback provider URL. Web lifecycle errors and child warnings containing the private route token are replaced with content-free bridge messages; native lifecycle traffic remains unchanged.

## Non-goals

- Bypassing authentication, subscription, quota, policy, CAPTCHA, or MFA controls.
- Emulating undocumented ChatGPT backend endpoints.
- Reading or copying an existing Chrome profile.
- Automatically approving local tools.
- Claiming that browser UI automation is as stable as a supported API.
