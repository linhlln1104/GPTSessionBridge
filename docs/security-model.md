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

This boundary is planned for Phase 3 and does not exist in the Phase 2 runtime. When implemented, the ChatGPT session will remain in Chrome. The extension will be trusted to interact with the explicitly connected page content, but it will not be granted cookie, debugger, history, broad host, or browser-profile access.

### Local transport boundary

The Phase 2 Responses boundary binds to an ephemeral port on `127.0.0.1`, authenticates with a high-entropy process capability, and limits headers, body size, connections, requests per socket, and request lifetime. Native Messaging will add an extension-identity boundary in Phase 3.

The capability lifecycle is:

1. The facade generates a fresh capability when its process starts.
2. The local Responses endpoint binds to an ephemeral loopback port.
3. For a Web-backed thread, the facade injects the endpoint and capability directly into the request's in-memory app-server configuration.
4. The trusted Codex child uses that configuration for the local Responses request.
5. The endpoint validates the loopback request and bearer capability before reading the bounded JSON body.
6. During Phase 2, a valid request terminates with `session_not_connected` because no browser session transport is installed.
7. The endpoint closes and the capability becomes unusable when the facade exits.

## Threats and controls

| Threat                      | Required control                                                            |
| --------------------------- | --------------------------------------------------------------------------- |
| Credential extraction       | No cookie/debugger permissions; no credential fields in protocols or logs   |
| Local process impersonation | Process-scoped capability, loopback binding, strict host/origin policy      |
| Extension impersonation     | Phase 3 Native Messaging extension allowlist                                |
| Prompt or response leakage  | Memory-only processing; content-free diagnostics; synthetic fixtures        |
| Provider confusion          | Pin the provider, model, reasoning effort, and catalog revision per thread  |
| Silent quota crossover      | Explicit errors; no automatic Codex/Web fallback                            |
| Duplicate submission        | Phase 3 sequence validation and one terminal event per request              |
| Unbounded input             | Frame-size, queue, timeout, and concurrency limits                          |
| UI drift                    | Phase 3 versioned capability report and fail-closed behavior                |
| Capability disclosure       | Memory-only token; no child environment, arguments, logs, or disk config    |
| Provider override injection | Reject reserved request, config-write, and command-line overrides           |
| Ambiguous thread identity   | Reject Web review/realtime flows and unsupported history or path identities |

## Diagnostics

Production diagnostics use an allowlisted event schema. They may contain a component name, event name, opaque correlation identifier, status, duration, and byte counts. They must not contain arbitrary request parameters, results, prompts, responses, configuration objects, browser content, credentials, account identifiers, or paths.

Debug mode does not relax these rules. A future support bundle must be opt-in, time-limited, scrubbed, and previewable before export.

## Routing constraints

The facade owns the reserved Web provider definition. A client cannot replace its base URL, capability, retry policy, or authentication flags through request-local provider configuration. Web routes disable provider fallback and pin the selected public model, provider model, reasoning effort, and catalog revision to the thread. Reserved model/provider values are also rejected in app-server config writes and command-line overrides.

Derived Web threads are accepted only when the facade can verify and pin their route. Reviews, realtime sessions, and steering are rejected for Web threads because their execution identity cannot yet be bound safely. A Web `thread/resume` request with inline history, or a Web resume/fork request carrying any rollout path, is also rejected because Phase 2 cannot prove that the supplied identity belongs to the pinned route.

Resume/fork sources are quarantined until the lifecycle response is validated. During that window, pipelined thread operations are rejected, server-initiated requests receive an error, and client responses to server requests are dropped. If a lifecycle response returns a mismatched model, provider, or thread identity, the facade records a bounded tombstone and terminates the proxy session.

## Non-goals

- Bypassing authentication, subscription, quota, policy, CAPTCHA, or MFA controls.
- Emulating undocumented ChatGPT backend endpoints.
- Reading or copying an existing Chrome profile.
- Automatically approving local tools.
- Claiming that browser UI automation is as stable as a supported API.
