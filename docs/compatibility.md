# Compatibility

GPTSessionBridge relies on integration surfaces that can change independently: the Codex app-server protocol, the Codex IDE extension's executable override, Chrome Native Messaging, and the visible ChatGPT Web interface.

## Policy

- Support is declared for tested version ranges, not assumed from package names.
- Unknown protocol methods pass through unless the bridge explicitly owns them.
- Runtime schemas validate every owned boundary.
- Startup rejects virtual-model collisions and incompatible protocol revisions.
- Unsupported browser capabilities and stale model catalogs fail closed.
- Installation changes are journaled and reversible.

The Codex app-server command and some transports are documented as experimental. See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server). The executable override used by IDE clients is a development setting, so each release must publish a tested compatibility matrix rather than promise unrestricted forward compatibility.

## Current matrix

No production compatibility is declared during pre-alpha development. The first runnable milestone will pin exact development versions in automated contract tests before adding a supported range here.

## Browser UI changes

The extension uses public, visible UI state rather than undocumented backend model identifiers. A browser adapter revision reports its capabilities to the bridge; if required semantics cannot be verified, the associated Web model is unavailable until the adapter is updated.
