# Security Policy

GPTSessionBridge is pre-alpha and has not received a security audit. The Phase 2 facade is runnable and the isolated Phase 3a Native Messaging transport foundation is implemented, but authenticated browser wiring and the ChatGPT Web adapter are not. The `main` branch is the only supported development line. No release should be treated as production-ready until this policy explicitly says otherwise.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository when it is available. If it is unavailable, open a minimal issue asking the maintainer to establish a private contact channel; do not include exploit details, credentials, account data, or user content in that issue.

Include only the minimum synthetic reproduction needed to understand the problem. Never attach a real browser profile, HAR file, cookie, token, prompt, response, source tree, or diagnostic archive.

## Security invariants

- ChatGPT session credentials remain inside the user's browser.
- Codex credentials remain under the official Codex client's authentication flow.
- The browser extension will connect only after an explicit user action.
- Browser permissions will remain limited to the required ChatGPT origin and Native Messaging.
- The Native Messaging host accepts one exact canonical extension origin; wildcard origins are rejected.
- Native Messaging frames are schema-checked, direction-checked, sequence-checked, and limited to 1 MiB on both links.
- Transport frames terminate at the native host. Relayed application frames receive a new link-local sequence.
- A protocol `hello` is never accepted as proof of local-process identity.
- Local network listeners bind only to loopback and require a process-scoped capability.
- The capability is generated per facade process, kept only in process memory, and never placed in child environment variables, command-line arguments, logs, or persistent configuration.
- The capability is injected directly into the in-memory app-server configuration sent to the official Codex child for a Web-backed thread. The official Codex child is therefore inside the trusted boundary.
- Protocol mismatches, disconnected sessions, and unavailable models fail closed.
- Provider selection never falls back silently.
- Client-supplied definitions and persistent config writes for the reserved Web provider or model namespace are rejected instead of merged or trusted.
- Reviews, realtime sessions, steering, unverified derived threads, and `thread/resume` or `thread/fork` requests carrying a rollout path fail closed for Web routes until their routing identity can be verified safely.
- Resume/fork sources are quarantined until their lifecycle identity is validated; server requests and pipelined thread operations cannot cross that boundary. Lifecycle notifications without a request identifier are dropped because they cannot be correlated with a validating response.
- A successful resume must return the requested thread identifier. A successful fork must return a new thread identifier and name the requested source in `thread.forkedFromId`.
- A thread identifier returned with an invalid lifecycle identity is tombstoned in bounded memory and the facade session terminates, preventing continued execution in an untrusted routing state.
- Diagnostics exclude prompts, responses, browser content, paths, configuration payloads, and credentials.
- The bridge does not add persistent storage for Web route metadata or conversation content, and telemetry is disabled by default. The official Codex child remains responsible for its normal thread storage according to the request and Codex configuration.

In the current runtime, an authenticated request to the local Responses endpoint returns `session_not_connected`. This remains the expected terminal state until authenticated browser wiring and the Responses adapter exist; the facade must not simulate a Web response or route the request to native Codex.

See [docs/security-model.md](docs/security-model.md) for the threat model.
