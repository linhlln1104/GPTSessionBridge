# Privacy

GPTSessionBridge is designed to keep account sessions in the products that created them.

## Data processed in memory

To perform a Web-backed turn, the participating processes may transiently handle the prompt, visible response text, public model selection, cancellation state, and the minimum tool protocol required by that turn. This content is not eligible for routine diagnostics.

## Data not collected by the bridge

The bridge must not collect or persist:

- ChatGPT cookies, browser storage, access tokens, or Chrome profiles;
- Codex credentials or authorization headers;
- account email, workspace identifiers, entitlement, or quota details;
- browsing history, unrelated tabs, clipboard data, or screenshots;
- prompts, responses, reasoning, source files, or tool output for telemetry.

## Storage and telemetry

The bridge does not add persistent storage for Web route metadata or conversation content, and its routing state is bounded and memory-only. The official Codex child owns its normal thread storage and may persist a rollout according to the request and Codex configuration. Bridge telemetry is disabled by default; logs use a fixed content-free schema and remain local.

## User control

The user explicitly chooses which ChatGPT tab to connect and which Web model to select. Disconnecting the tab or extension ends its availability. The bridge does not open a separate login window or silently choose another provider when the selected session is unavailable.
