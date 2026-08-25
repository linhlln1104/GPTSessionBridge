# Compatibility

GPTSessionBridge relies on integration surfaces that can change independently: the Codex app-server protocol, the Codex IDE extension's executable override, Chrome Native Messaging, and the visible ChatGPT Web interface.

## Policy

- Support is declared for tested version ranges, not assumed from package names.
- Unknown protocol methods pass through unless the bridge explicitly owns them.
- Runtime schemas validate every owned boundary.
- Virtual-model collisions are rejected when the relevant native catalog page is observed.
- Versioned bridge-owned boundaries reject incompatible protocol revisions; the facade does not claim a startup compatibility gate for the upstream app-server protocol.
- Unsupported browser capabilities and stale model catalogs fail closed.
- Installation changes are journaled and reversible.

The Codex app-server command and some transports are documented as experimental. See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server). The executable override used by IDE clients is a development setting, so each release must publish a tested compatibility matrix rather than promise unrestricted forward compatibility.

## Current matrix

No production compatibility is declared during pre-alpha development.

The following development snapshot was tested on 2026-08-25:

| Component        | Tested value        | Scope                                          |
| ---------------- | ------------------- | ---------------------------------------------- |
| Operating system | Windows x64         | Local stdio facade and loopback Responses stub |
| Codex CLI        | `0.149.0-alpha.4.3` | Official `codex app-server` child              |
| Node.js          | `24.18.1`           | Workspace build, tests, facade, and smoke test |

Verified behavior in this snapshot:

- The facade starts the official Codex app-server over stdio and preserves unowned protocol messages.
- Native `model/list` pagination completes before the synthetic `gptsessionbridge/web/example-model` entry is appended.
- Selecting the synthetic model pins the reserved local provider without allowing model or provider fallback.
- Automated integration tests verify that a valid request reaches the authenticated loopback Responses endpoint and returns `session_not_connected`, which is the expected Phase 2 result. The installed-Codex smoke test covers the app-server handshake and model catalog only.

This matrix does not claim IDE-extension, macOS, Linux, Chrome, real-account, or ChatGPT Web compatibility. The synthetic model is a development fixture, not a supported model route.

## Phase 2 restrictions

- Only the stdio app-server facade is owned by the bridge. Other Codex invocations pass through to the official executable.
- Client-supplied overrides for the reserved Web provider are rejected.
- Reserved model/provider values are rejected in app-server config writes and command-line overrides. Existing user-managed Codex configuration remains part of the trusted local boundary; lifecycle results that report the reserved namespace fail closed before a turn can start.
- Reviews, realtime sessions, and steering are rejected for Web-backed threads.
- Web `thread/resume` requests with inline history and Web resume/fork requests carrying any rollout path are rejected.
- Web route metadata is process-local; resuming a Web thread after restarting the facade is not supported in Phase 2.
- Resume/fork sources remain quarantined until Codex returns a matching lifecycle identity. A mismatch terminates the facade session and requires the client to reconnect.
- Client notifications pass through the same thread and configuration guards as requests. Request-only lifecycle, initialization, and catalog operations are dropped when sent without an identifier.
- The local provider has no browser session until Phase 3 and therefore returns `session_not_connected`.

## Browser UI changes

Phase 3 will use public, visible UI state rather than undocumented backend model identifiers. A browser adapter revision will report its capabilities to the bridge; if required semantics cannot be verified, the associated Web model will remain unavailable until the adapter is updated.
