# GPTSessionBridge

GPTSessionBridge is a local bridge that lets a Codex client route an explicitly selected thread to a ChatGPT Web model while the user's ChatGPT session remains inside their existing browser.

> [!WARNING]
> This project is pre-alpha and not production-ready. The Phase 2 app-server facade and synthetic Web model route are runnable, but the browser extension is planned for Phase 3. A Web request currently fails with `session_not_connected` after the local provider boundary verifies it.

## Design goals

- Never ask users to sign in to ChatGPT inside an unfamiliar desktop application.
- Never export or persist ChatGPT cookies, access tokens, or browser profiles.
- Let users choose a connected Web model from the Codex model picker.
- Keep Codex authentication, approvals, sandboxing, and native threads under the official Codex app-server.
- Fail closed when a browser session, model, or protocol capability is unavailable.
- Keep diagnostics content-free and telemetry disabled by default.

## Architecture

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

The Phase 2 facade launches the official Codex app-server, preserves the JSON meaning of unowned protocol messages, appends a synthetic Web model to paginated `model/list` results, and pins the local Web provider when that model is selected. Native Messaging and the browser extension are Phase 3 components.

### Available in Phase 2

- A runnable stdio app-server facade backed by the official Codex child process.
- Semantic pass-through for unowned app-server messages.
- Paginated native model discovery with a synthetic `gptsessionbridge/web/example-model` entry.
- Thread-scoped Web provider, model, reasoning-effort, and catalog-revision pinning.
- An authenticated, loopback-only Responses endpoint with bounded request handling.
- Explicit rejection of provider switching, reserved provider/config overrides, Web review/realtime/steering flows, and unsupported resume identities.

### Not available yet

- Connection to an existing `chatgpt.com` tab.
- Real ChatGPT Web model discovery or response streaming.
- Native Messaging host, browser extension, installer, or local tool loop.

The current Responses endpoint therefore returns HTTP 503 with `session_not_connected` for a valid Web request. The synthetic model exists to verify the facade and model-picker integration; it is not a usable ChatGPT model.

Switching between Codex and Web providers requires a new thread. The bridge never silently falls back to another provider or model.

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
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Useful commands:

```shell
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:app-server
```

`smoke:app-server` builds the workspace, launches the facade against the installed Codex CLI, and verifies the app-server handshake plus synthetic model catalog contract. Automated integration tests verify the current `session_not_connected` provider response. Neither path contacts ChatGPT Web.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Project status

Phase 2 establishes a runnable app-server facade, model-catalog augmentation, fail-closed thread routing, an authenticated local provider boundary, versioned protocols, and repository quality gates. Browser automation and real-account fixtures are deliberately excluded until Phase 3.

The current compatibility snapshot was tested on 2026-08-25 with Codex CLI `0.149.0-alpha.4.3`, Node.js `24.18.1`, and Windows x64. See [Compatibility](docs/compatibility.md) for the exact scope and limitations.

GPTSessionBridge is an independent project. It is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of their respective owner.

The architecture was informed by the MIT-licensed [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. GPTSessionBridge uses a different browser-session boundary and is being implemented clean-room unless a future notice states otherwise.

## License

[MIT](LICENSE)
