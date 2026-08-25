# Security Policy

GPTSessionBridge is pre-alpha and has not received a security audit. The `main` branch is the only supported development line. No release should be treated as production-ready until this policy explicitly says otherwise.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository when it is available. If it is unavailable, open a minimal issue asking the maintainer to establish a private contact channel; do not include exploit details, credentials, account data, or user content in that issue.

Include only the minimum synthetic reproduction needed to understand the problem. Never attach a real browser profile, HAR file, cookie, token, prompt, response, source tree, or diagnostic archive.

## Security invariants

- ChatGPT session credentials remain inside the user's browser.
- Codex credentials remain under the official Codex client's authentication flow.
- The browser extension connects only after an explicit user action.
- Browser permissions remain limited to the required ChatGPT origin and Native Messaging.
- Local network listeners bind only to loopback and require a process-scoped capability.
- Protocol mismatches, disconnected sessions, and unavailable models fail closed.
- Provider selection never falls back silently.
- Diagnostics exclude prompts, responses, browser content, paths, configuration payloads, and credentials.
- Persistent conversation storage and telemetry are disabled by default.

See [docs/security-model.md](docs/security-model.md) for the threat model.
