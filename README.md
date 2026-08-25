# GPTSessionBridge

GPTSessionBridge is a local bridge that lets a Codex client route an explicitly selected thread to a ChatGPT Web model while the user's ChatGPT session remains inside their existing browser.

> [!WARNING]
> This project is pre-alpha. The browser bridge, model routing, installer, and tool loop are not implemented yet. Do not use it with sensitive work.

## Design goals

- Never ask users to sign in to ChatGPT inside an unfamiliar desktop application.
- Never export or persist ChatGPT cookies, access tokens, or browser profiles.
- Let users choose a connected Web model from the Codex model picker.
- Keep Codex authentication, approvals, sandboxing, and native threads under the official Codex app-server.
- Fail closed when a browser session, model, or protocol capability is unavailable.
- Keep diagnostics content-free and telemetry disabled by default.

## Planned architecture

```text
Codex IDE extension
        |
        | app-server protocol
        v
GPTSessionBridge facade --------> official Codex app-server
        |
        | local Responses provider
        v
Native Messaging host <--------> browser extension <--------> selected chatgpt.com tab
```

The facade will pass unknown app-server messages through unchanged, add connected Web models to `model/list`, and pin a model provider when a thread is created. Switching between the Codex and Web providers will require a new thread; the bridge will not silently fall back to another provider.

See [Architecture](docs/architecture.md), [Security model](docs/security-model.md), and [Privacy](docs/privacy.md) for the current contracts.

The integration surface is based on the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Repository layout

```text
apps/       Executable bridge, Native Messaging host, and browser extension
packages/   Runtime contracts and I/O-free core logic
tests/      Cross-package contract and integration tests
docs/       Architecture, security, compatibility, and decision records
```

Only packages that contain working code are added to the repository.

## Development

Requirements:

- Node.js 24
- Corepack
- Git

```shell
corepack pnpm install
corepack pnpm verify
```

Useful commands:

```shell
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Project status

The current milestone establishes versioned protocols, security primitives, and repository quality gates. Browser automation and real-account fixtures are deliberately excluded from automated tests.

GPTSessionBridge is an independent project. It is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of their respective owner.

The architecture was informed by the MIT-licensed [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. GPTSessionBridge uses a different browser-session boundary and is being implemented clean-room unless a future notice states otherwise.

## License

[MIT](LICENSE)
