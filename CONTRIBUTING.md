# Contributing

GPTSessionBridge is security-sensitive software. Contributions should be small, reviewable, and backed by tests at every trust boundary.

## Set up the workspace

Install Node.js 24 and enable Corepack, then run:

```shell
corepack pnpm install
corepack pnpm verify
```

Do not disable strict peer-dependency or engine checks to make a local installation pass.

## Change requirements

- Keep dependency direction from applications to pure packages; do not introduce circular imports.
- Validate untrusted input at runtime before it reaches core logic.
- Preserve unknown app-server messages unless the router explicitly owns the method.
- Add tests for success, cancellation, malformed input, disconnection, and terminal-state behavior.
- Never add silent model or provider fallback.
- Keep Native Messaging `stdout` exclusively for framed protocol bytes; diagnostics belong on `stderr` and must use the safe schema.
- Keep comments focused on public invariants. Put durable architectural rationale in an ADR.

## Sensitive-data rules

Never commit or attach:

- cookies, authorization headers, API keys, session tokens, or browser profiles;
- prompts, responses, reasoning, tool output, source files, or raw DOM/network captures from a real account;
- account identifiers, email addresses, quota details, hostnames, or absolute user paths;
- `.env` files, certificates, crash dumps, session state, or diagnostic bundles;
- private implementation notes, conversation transcripts, or automated attribution trailers.

Fixtures must be synthetic. Use reserved examples such as `user@example.invalid`, `/workspace/project`, and intentionally invalid tokens.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(protocol): add versioned native messaging frames
fix(security): reject a replayed request
test(bridge): cover interleaved app-server messages
docs: clarify the browser trust boundary
```

Keep each commit buildable and independently reviewable. Use `!` and a `BREAKING CHANGE:` footer for incompatible public protocol changes.

## Pull requests

Before requesting review:

1. Run `corepack pnpm verify`.
2. Review the diff for credentials, user content, local paths, and generated files.
3. Explain externally observable behavior and security impact.
4. Link an ADR when the change alters a trust boundary or compatibility policy.
5. Confirm that disconnects and unsupported capabilities fail closed.

Report security vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public pull request.
