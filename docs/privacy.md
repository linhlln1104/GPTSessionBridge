# Privacy

GPTSessionBridge is designed to keep account sessions in the products that created them.

## Data processed in memory

To perform a supported Web-backed turn, the participating processes may transiently handle bounded prompt text, visible response text, public model selection, catalog revision, and cancellation state. Protocol v1 does not support tool calls. This content is not eligible for routine diagnostics.

Protocol v2 is not active. If the experimental Web Agent profile is implemented, its explicit consent surface must disclose that developer instructions, user input, selected source excerpts, tool schemas, tool arguments, and bounded tool output are rendered through the visible ChatGPT conversation and may therefore enter normal ChatGPT history. None of that content becomes eligible for bridge telemetry or diagnostics.

## Data not collected by the bridge

The bridge must not collect or persist:

- ChatGPT cookies, browser storage, access tokens, or Chrome profiles;
- Codex credentials or authorization headers;
- account email, workspace identifiers, entitlement, or quota details;
- browsing history, unrelated tabs, clipboard data, or screenshots;
- prompts, responses, reasoning, source files, or tool output for telemetry.

The UI adapter does not call undocumented or private ChatGPT backend endpoints. It operates visible controls and text only; it does not derive account or model identity from cookies, tokens, browser storage, or page-internal JavaScript state.

## Storage and telemetry

The bridge does not add persistent storage for Web route metadata or conversation content, and its routing state is bounded and memory-only. The official Codex child owns its normal thread storage and may persist a rollout according to the request and Codex configuration. A prompt submitted through the visible ChatGPT composer and its response may remain in normal ChatGPT history according to the user's account and history settings; GPTSessionBridge does not delete or hide that conversation. Bridge telemetry is disabled by default; logs use a fixed content-free schema and remain local.

## User control

The user explicitly chooses which fresh ChatGPT tab to connect and which `Web · …` model to select. Disconnecting the tab or extension ends its availability. The bridge does not open a separate login window, navigate to New chat, submit into an existing transcript, or silently choose another provider when the selected session is unavailable. A future `Web Agent (experimental)` model requires a separate, expiring document-bound activation gesture; connecting a text-only tab is not consent to share coding context or tool output.
