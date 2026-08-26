# ADR 0004: Use an Explicit-Tab, UI-Only ChatGPT Web Adapter

- Status: Accepted
- Date: 2026-08-25
- Implementation: Text-only model discovery and turn streaming implemented; real-account compatibility and tool-call support remain release gates

## Context

GPTSessionBridge must use the ChatGPT session that already exists in the user's browser without asking the user to sign in to an unfamiliar application. Exporting cookies, browser storage, bearer tokens, or a Chrome profile would move account credentials across the browser boundary. Calling undocumented ChatGPT backend endpoints would create the same credential risk and would couple the project to an unsupported protocol.

The visible ChatGPT interface is less stable than a supported API. Model labels and semantic controls can change, a single-page navigation can replace the selected document's conversation, and sending into an existing conversation could disclose source context or append an unintended message. The adapter therefore needs a narrow consent and ownership model with fail-closed behavior.

Codex discovers models through `model/list`, while a later Responses request contains the provider-facing model value. A Web catalog can change between those operations. A displayed model identity must therefore remain separate from the exact, revision-bound route used by the local provider.

## Decision

The browser extension operates only the exact `https://chatgpt.com` main-frame document selected when the user presses Connect. It injects an isolated-world content script under the temporary `activeTab` grant and binds the extension port to Chrome's returned `documentId`. Navigation, port loss, protocol failure, or ambiguous UI state ends the session; the extension does not reconnect or submit automatically.

### UI-only boundary

The content adapter may:

- inspect visible DOM and accessibility semantics in the selected document;
- click the visible model picker, model option, send button, and stop button;
- write bounded text into the visible composer through ordinary DOM input events; and
- read bounded visible assistant text from the conversation DOM.

It must not read cookies, local or session storage, IndexedDB, service-worker state, page JavaScript objects, browser history, account identifiers, or authorization material. It must not issue ChatGPT `fetch`, XHR, WebSocket, GraphQL, or other backend requests. It does not use debugger APIs, a main-world credential shim, screenshots, or copied HTML.

Selectors are based on semantic roles, accessible names, form relationships, author roles, and visible state. Generated CSS class names and undocumented backend model identifiers are not accepted as identity. Every state-changing click is verified from subsequent visible semantic state. Zero matches, multiple matches, missing selection state, or a timeout is an adapter failure rather than a guess.

The direct picker is semantic-label driven. Recognition of the currently observed nested picker shape relies on the submenu's English accessible name `Model`; localized submenu names are not yet certified. An unrecognized localized or changed picker remains unavailable rather than falling back to text position or an undocumented identifier.

### Conversation ownership

Before its first turn, the adapter requires a fresh ChatGPT conversation surface at `/` with no visible user or assistant messages and an idle, empty composer. It never clicks New chat, clears an existing conversation, or navigates on the user's behalf.

After submitting the first prompt, it records the first newly visible user-message element and the resulting conversation path. Later turns are allowed only while that element remains the first user message and the path remains the owned path. DOM replacement, navigation to another conversation, an extra uncorrelated message, or an ambiguous start fails the turn and disconnects as appropriate. Prompts are never replayed after failure.

This guard prevents the adapter from appending to a conversation the user was already using. It does not make the visible ChatGPT conversation ephemeral: submitted prompts and responses remain subject to the user's ChatGPT history and account settings.

### Catalog discovery and selection

Catalog discovery opens the visible model picker only in response to a bridge capability read. The adapter supports both a direct option list and the currently observed nested Model submenu. Each enabled option must expose one normalized accessible label, one semantic path, and an unambiguous selected state.

The extension derives a bounded opaque model ID and catalog revision from normalized semantic UI descriptions using SHA-256. These values contain no account credential or private backend identifier. Each discovered model currently advertises:

- text input;
- streaming visible output;
- cancellation through a verified stop control;
- no image input, temporary-chat guarantee, or tool calls; and
- one Codex-compatible `medium` reasoning label. This is compatibility metadata only and does not control ChatGPT Web reasoning, which remains UI-defined.

Selecting a model opens the picker, clicks exactly one matching semantic option, reopens the picker, and confirms exactly one selected match. If ChatGPT changes the catalog after it was advertised, the revision changes and the old route cannot start.

After selecting the model, the adapter performs a final revalidation of the request-bound catalog and exact semantic option before touching the composer. Drift detected there fails closed without submitting the prompt. The composer write and Send click then execute synchronously before the driver first yields. Once that click is issued, a later catalog snapshot is published for future route resolution only; it does not cancel, replay, reselect, or reroute the active owned turn. If visible start or conversation ownership cannot subsequently be confirmed, the turn fails without automatic replay and the prompt may still remain in ChatGPT history. An active turn continues only while its owned path, first adapter-created user message, and visible assistant surface remain unambiguous; ownership or surface drift fails it.

### Facade and Responses routing

The facade projects the coordinator's current immutable capability snapshot into `model/list` entries named `Web · <visible label>`. The public picker key is bound cryptographically to the selected session, snapshot generation, catalog revision, and browser model ID. It intentionally changes after reconnect or catalog replacement so a selection issued by an old tab cannot migrate to a new one. It does not expose the provider route token or the identity inputs.

For each current model, the bridge creates a separate short opaque provider token from the same exact snapshot identity. The token is not a secret or authenticator. The local Responses server resolves it only against the coordinator's current snapshot, carries the expected session and generation into `startTurn`, and never decodes a token or substitutes the latest revision. A stale or unknown token fails with an explicit model-unavailable error.

The provider token remains child-facing. The facade rewrites successful Web lifecycle model metadata back to the pinned public picker key; rejects any residual private route token, bearer capability, or loopback provider URL; and replaces Web lifecycle errors or child warnings containing the private route token with content-free compatibility messages before forwarding them to the IDE. Native lifecycle traffic remains unchanged.

The local Responses adapter accepts exactly one bounded user text item that protocol v1 can preserve. It rejects multiple messages or content parts, tools, images, non-user roles, instructions, previous-response chaining, persistence requests, structured output, and unknown request semantics instead of joining, discarding, or flattening them. Streaming produces the minimal Responses text lifecycle, respects backpressure and output bounds, and propagates client disconnects as cancellation.

Consequently, this increment enables real UI model discovery, selection, and plain-text turns, but it does not yet provide a complete Codex coding-agent workflow. Normal Codex coding requests in the tested snapshot carry developer instructions and tool definitions that this endpoint rejects. Adding those semantics requires a separate protocol and security decision; prompt-based imitation of tool calls is not accepted.

## Consequences

- The browser remains the only holder of the ChatGPT login session.
- Model labels visible in VS Code come from the explicitly selected tab and disappear when its coordinator snapshot is unavailable.
- Catalog or selected-model drift detected by the final pre-submit revalidation fails closed. Catalog changes after the synchronous Send click affect future routes only; the active owned turn is neither replayed nor rerouted and still fails on start-confirmation, ownership, or response-surface drift.
- The observed nested picker currently depends on the English accessible name `Model`; localized UI compatibility remains unverified.
- UI changes can temporarily disable the adapter until semantic fixtures are updated.
- A first Web turn requires the user to connect a fresh ChatGPT conversation surface.
- Visible prompts and responses may appear in normal ChatGPT history according to the user's settings, even though the bridge adds no conversation persistence.
- Real-browser and real-account compatibility must be tested manually or in an explicitly authorized fixture. Automated unit coverage currently uses a fake UI driver and pure semantic/state helpers; it does not yet run the DOM driver in a browser DOM-runtime fixture.

## Rejected alternatives

- Asking the user to sign in through a bridge-owned desktop window.
- Copying cookies, tokens, browser storage, or a Chrome profile into the bridge.
- Calling undocumented ChatGPT backend endpoints from the extension or local process.
- Using debugger or broad persistent host permissions.
- Treating displayed labels as backend API model identifiers.
- Sending into an existing conversation or automatically creating/navigating to a chat.
- Silently choosing a different model when catalog selection cannot be verified.
- Encoding tool calls in prose and trusting an unverified parser to execute them.
