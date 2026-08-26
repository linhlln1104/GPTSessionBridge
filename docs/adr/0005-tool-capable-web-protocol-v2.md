# ADR 0005: Gate Tool-Capable Web Protocol v2 Behind an Experimental Agent Profile

- Status: Accepted
- Date: 2026-08-26
- Implementation: Active in the unsigned personal-use MVP behind an exact document-bound consent lease; current-Codex projection, Responses lifecycle, authenticated agent transport, exact DOM-envelope capture, child-owned continuation, and `Web Agent · …` catalog publication are implemented. Packaged-extension real-browser E2E and real-account compatibility are not certified.

## Context

The protocol v1 Web route intentionally accepts one bounded user-text item. It rejects developer instructions, tool definitions, tool calls, continuation items, and other Responses semantics rather than flattening them. That boundary is safe for plain-text turns, but it cannot serve a normal Codex coding-agent workflow.

The official Codex app-server owns thread state, tool execution, approval requests, sandbox policy, and lifecycle events. A Responses provider can return structured function-call items that let the child retain those responsibilities. ChatGPT Web, however, exposes a visible composer and visible assistant text rather than an API-level developer channel or authenticated function-call item. Text entered into that composer is user-role content. Labels that say “developer” or “tool” do not restore the instruction hierarchy of a native Responses request.

A model-generated JSON object read from the page is also untrusted model output. A round challenge can correlate that output with one submitted prompt and reject stale or replayed responses, but the model and page can both read the challenge. It is not an authenticator and does not prevent prompt injection.

## Decision

GPTSessionBridge defines a separate protocol v2 workflow for an activation-gated `Web Agent · …` profile. It is a compatibility mode, not a claim of complete Responses API equivalence. The existing `Web · …` profile remains text-only and fail-closed.

### Authority remains in the official child

The official Codex child remains the only component allowed to:

- decide whether a proposed tool is eligible under its configured policy;
- request and receive approval through the normal app-server client channel;
- execute a command or other local tool;
- apply sandbox restrictions and preserve the tool lifecycle; and
- produce the function-call output used for the next model round.

The bridge validates and translates protocol items. The extension transports bounded visible text. Neither component executes a tool, answers an approval request, weakens a sandbox, or synthesizes a successful tool result.

The provider request does not expose authoritative sandbox or approval-policy state to the bridge, so the personal-use MVP does not claim an independently enforced policy floor. The official Codex child and connected client apply their configured sandbox and approval behavior. The bridge and extension cannot answer approvals, execute a proposal, synthesize a successful result, or weaken that policy. Any future claim that the bridge itself enforces a policy floor requires an authoritative app-server contract and another security decision backed by fixtures and adversarial tests.

### Explicit, short-lived activation

Tool capability is absent by default. A user gesture in the extension creates a short-lived activation lease for the exact selected main-frame document. The lease expires on unrelated navigation, document replacement, disconnect, bridge restart, explicit deactivation, or 15 minutes of inactivity. The only adopted navigation is the initial `/` to `/c/...` transition anchored to the adapter's own submitted first message.

Each agent thread must explicitly select the `Web Agent · …` profile while that lease is current. A tool-bearing request never upgrades a v1 route, silently activates v2, falls back to native Codex, or migrates to another browser tab. Loss of any activation or route binding is terminal for the affected turn.

Before activation, the UI must disclose that developer context, source excerpts, tool arguments, and tool outputs can be written into the visible ChatGPT conversation and retained according to the user’s ChatGPT settings.

### Lossy request projection is visible and bounded

For an admitted request, the bridge creates a deterministic visible-composer projection containing the accepted instructions, ordered developer/user text inputs, exact derived and certified tool manifest, public workflow alias, round number, and fresh challenge. Instruction and developer material is labeled for compatibility, but remains user-role content on ChatGPT Web. The bridge does not claim or signal that native role precedence was preserved.

`client_metadata`, `prompt_cache_key`, account identifiers, native thread identifiers, browser session identifiers, provider route tokens, bearer capabilities, and loopback endpoint details never enter the browser projection. Values needed for continuation validation remain in a memory-only binding record.

The MVP projector derives a memory-only profile from function-tool entries in the tested Codex child request. It retains at most 32 functions whose parameters match the locally certified, recursively closed JSON Schema subset, requires `exec_command`, and hashes the exact ordered names, descriptions, strict flags, and schemas into a dynamic profile version and manifest digest. A malformed or uncertifiable function entry rejects the request. Built-in tools, namespace markers, MCP or app tools, Web search, plugin installation, media inputs, and non-text tool outputs never become callable Web tools. Adding or changing a function schema must remain inside the certified subset and necessarily changes the manifest binding.

### Whole-response envelope

The DOM response is buffered to completion. The entire visible assistant response must be one protocol v2 envelope: fixed begin and end lines surrounding one single-line, closed-schema JSON object. Prose, Markdown fences, a byte-order mark, CRLF framing, duplicate or prototype-sensitive keys, non-canonical or unsafe numbers, invalid Unicode, unknown fields, trailing data, oversized values, excessive depth, or excessive node count are rejected.

An envelope is either one tool proposal or one final response. The initial implementation allows one proposed tool per round. The Web model does not choose the real Responses `call_id`; the bridge mints it only after validating the envelope, route, tool name, argument schema, round challenge, manifest digest, and current DOM ownership.

The challenge is 192 random bits and is single-use. It rejects stale, cross-round, and replayed envelopes. Because it is visible to the model, it provides correlation and freshness only—not origin authentication, integrity against a compromised page, or prompt-injection resistance.

Manifest and argument bindings use the JSON Canonicalization Scheme in RFC 8785, restricted further to safe integers and already-canonical incoming number tokens. Canonical UTF-8 bytes, SHA-256, and canonical unpadded base64url encoding are covered by a published test vector. This avoids platform-dependent property order, numeric rounding, or digest aliases at the security boundary.

The normative format, limits, state machine, response mapping, and errors are defined in [Tool-Capable Web Workflow Protocol v2](../protocol-v2.md).

### Exact state binding and at-most-once commit

Every workflow is bound in memory to the exact selected document, browser session and generation, catalog revision, visible model, provider route, Codex thread and turn, canonical request prefix, tool manifest, round, challenge, and pending child call. Public aliases reveal none of those private identities.

The continuation request must preserve the canonical initial message prefix, exact derived function profile, and cumulative alternating function-call/output history. Every previous pair is checked against the stored history fingerprint; the newly appended final pair must be the exact pending bridge-issued call followed by one matching output. A mismatch, manual transcript mutation, navigation, model drift, duplicate DOM delivery, transport loss, or child lifecycle anomaly terminates the workflow.

The bridge records a tool-call commit before emitting the first function-call event to the child. A committed call is never emitted a second time, even after client disconnect or ambiguous completion. Prompts, tool calls, and provider requests are never replayed automatically.

### Activation and release scope

The repository connects the strict Responses request/lifecycle boundary, current-Codex projector, in-memory agent-session coordinator, authenticated Native Messaging/page route, one-shot selected-document permit, exact DOM response path, extension-local consent lease, and dynamic Web Agent model publication. The catalog advertises the route only while the exact lease and browser binding are active; the independent text capability continues to report `toolCalls: false`.

The personal-use MVP is eligible to advertise its separate Web Agent profile only while the following repository verification and contract gates remain present and passing:

- strict request, continuation, envelope, tool-schema, and canonicalization codecs with cross-platform digest vectors;
- current-Codex request/continuation fixtures plus the content-free opt-in contract probe for initial and cumulative request shapes;
- direct Chrome DOM-runtime fixtures for full-response capture, ownership, navigation, model drift, cancellation, and duplicate delivery;
- adversarial coverage for injection, malformed JSON, stale challenges, replay, cross-turn collision, schema drift, oversized data, disconnects before and after commit, and at-most-once execution;
- the activation lease and privacy disclosure UI;
- content-free diagnostics and secret/policy scans for the dynamic closed-schema tool-profile boundary; and
- explicit model publication gated by the authenticated activation snapshot.

These gates permit an unsigned personal-use MVP, not a production compatibility claim. A packaged extension and Native Host exercised through a real Chrome profile, a real-account ChatGPT coding turn, stable/localized DOM support, independent security review, protected installation, signing, and a production extension identity remain separate release gates. The existence of the active v2 route does not widen the v1 text schema or turn `toolCalls: false` into an agent capability advertisement.

## Consequences

- Tool execution, approval, and sandbox authority remain in the official Codex child.
- Protocol v2 can represent a bounded function-call loop without parsing prose as executable intent.
- Full assistant output must be buffered before validation, so Responses streaming is delayed and cannot expose raw partial envelope text as trusted events.
- The Web workflow is semantically weaker than a native Responses provider because developer-role priority is not preserved in the visible composer.
- The challenge reduces replay and correlation errors but cannot authenticate model output.
- Tool outputs and source context can enter normal ChatGPT history; this is an explicit privacy tradeoff, not an ephemeral or zero-retention channel.
- UI or child-contract drift disables the Web Agent profile rather than downgrading the checks.
- Protocol v1 remains independently usable for plain-text Web turns.

## Rejected alternatives

- Flipping the v1 `toolCalls` flag without a separate protocol and activation lease.
- Parsing prose, Markdown code fences, or a JSON fragment from an otherwise free-form answer.
- Treating a visible nonce, transcript hash, or manifest digest as proof of origin.
- Executing tools in the extension, Native Messaging host, bridge, or DOM adapter.
- Auto-approving requests or mirroring a weaker sandbox in bridge code.
- Presenting composer labels as preserved developer-role hierarchy.
- Sending private route identity, bearer capabilities, `client_metadata`, or `prompt_cache_key` to the browser.
- Replaying a prompt, function call, or tool result after timeout or transport failure.
- Treating every observed Codex tool entry as callable without type filtering, a certified closed schema, an exact manifest digest, and current-child contract fixtures.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
