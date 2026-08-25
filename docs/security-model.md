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

### Browser boundary

The ChatGPT session remains in Chrome. The extension is trusted to interact with the connected page content, but it is not granted cookie, debugger, history, broad host, or browser-profile access.

### Local transport boundary

Native Messaging validates the packaged extension identity. Any loopback transport binds to `127.0.0.1`, authenticates with a high-entropy process capability, limits message size and lifetime, and rejects replayed requests where applicable.

## Threats and controls

| Threat                      | Required control                                                           |
| --------------------------- | -------------------------------------------------------------------------- |
| Credential extraction       | No cookie/debugger permissions; no credential fields in protocols or logs  |
| Local process impersonation | Process-scoped capability, loopback binding, strict host/origin policy     |
| Extension impersonation     | Native Messaging extension allowlist                                       |
| Prompt or response leakage  | Memory-only processing; content-free diagnostics; synthetic fixtures       |
| Provider confusion          | Pin the provider, model, reasoning effort, and catalog revision per thread |
| Silent quota crossover      | Explicit errors; no automatic Codex/Web fallback                           |
| Duplicate submission        | Sequence validation and one terminal event per request                     |
| Unbounded input             | Frame-size, queue, timeout, and concurrency limits                         |
| UI drift                    | Versioned adapter capability report and fail-closed behavior               |

## Diagnostics

Production diagnostics use an allowlisted event schema. They may contain a component name, event name, opaque correlation identifier, status, duration, and byte counts. They must not contain arbitrary request parameters, results, prompts, responses, configuration objects, browser content, credentials, account identifiers, or paths.

Debug mode does not relax these rules. A future support bundle must be opt-in, time-limited, scrubbed, and previewable before export.

## Non-goals

- Bypassing authentication, subscription, quota, policy, CAPTCHA, or MFA controls.
- Emulating undocumented ChatGPT backend endpoints.
- Reading or copying an existing Chrome profile.
- Automatically approving local tools.
- Claiming that browser UI automation is as stable as a supported API.
