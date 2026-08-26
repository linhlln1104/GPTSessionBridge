# Tool-Capable Web Workflow Protocol v2

- Status: Experimental personal-use MVP; active only behind an exact document-bound consent lease
- Version: 2
- Decision: [ADR 0005](adr/0005-tool-capable-web-protocol-v2.md)

## 1. Scope

This document specifies a bounded function-tool workflow between the official Codex child and one user-selected ChatGPT Web document. It defines request admission, browser-visible envelopes, local binding, state transitions, Responses mapping, limits, failure behavior, and activation gates.

Protocol v2 is a workflow layered above Native Messaging protocol v2 and its strictly parsed page-message transport. Agent availability is negotiated through separate activation-status messages and an exact one-shot agent-turn command. The visible-model capability snapshot continues to report `toolCalls: false` for the independent text-turn contract; that field is not the Web Agent activation signal.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 2. Roles and authority

| Role                        | Responsibility                                                                                                         | Must not do                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Official Codex child        | Own thread state, approvals, sandbox policy, execution, and function-call outputs                                      | Delegate execution authority to bridge or browser code                         |
| Facade and v2 coordinator   | Admit the strict request subset, bind state, validate envelopes and continuations, mint call IDs, map Responses events | Execute tools, answer approvals, weaken policy, replay calls                   |
| `BrowserSessionCoordinator` | Pin the selected session, generation, catalog revision, model, and active turn                                         | Substitute the latest route or reconnect implicitly                            |
| Extension and DOM adapter   | Submit bounded visible text and return one bounded complete assistant response from the owned conversation             | Read credentials, call ChatGPT backend endpoints, parse or execute tool intent |
| ChatGPT Web model           | Produce an untrusted protocol proposal or final text                                                                   | Choose a trusted call ID or grant execution authority                          |

All model and page content is untrusted. Successful envelope parsing means only that the content is structurally eligible for evaluation by the official child.

## 3. Activation profile

The user-facing profile is named `Web Agent · <visible model>` and is distinct from the text-only `Web · <visible model>` profile.

Activation requires:

1. an explicit user gesture in the extension for the exact selected `https://chatgpt.com` main-frame document;
2. a privacy disclosure accepted for the current lease;
3. an active status snapshot returned through the authenticated browser transport for that same document generation;
4. explicit selection of the corresponding revision-bound `agent-v2` model route;
5. a request matching the tested Codex provider contract and a locally certified closed-schema function-tool profile; and
6. a fresh, transcript-free ChatGPT `/` surface for the first round.

The activation lease expires on document or tab replacement, unrelated navigation, disconnect, bridge restart, explicit deactivation, or 15 minutes of inactivity. The adapter may adopt only the initial `/` to `/c/...` transition anchored to its own submitted first message. Every v2 workflow MUST use the explicitly selected Web Agent route while a current lease exists. No provider request can create the lease implicitly; only admitted agent activity against the exact active binding can renew its inactivity deadline.

The bridge does not receive an authoritative sandbox or approval-policy field in the admitted Responses request and therefore does not claim to enforce a second policy floor. The official Codex child and its connected client remain responsible for their configured sandbox, approval decisions, and execution lifecycle. The bridge and extension MUST NOT answer an approval request, execute a proposal, or weaken that policy. A future claim of bridge-enforced policy requires an authoritative app-server contract, fixtures, and an explicit amendment to ADR 0005.

## 4. Request admission and projection

### 4.1 Initial request

The v2 Responses endpoint MUST use an allowlisted projector tied to a tested Codex child contract. The canonical request admitted by `ResponsesServerV2` contains:

- one current opaque Web provider model route;
- bounded `instructions`;
- ordered, text-only developer and user message content;
- a dynamically versioned list of locally certified function tools with exact names, descriptions, strict flags, and closed JSON schemas;
- `store: false`;
- the admitted streaming and reasoning values, `tool_choice: "auto"`, and bridge-enforced serial function calls; and
- no browser-visible local compatibility metadata.

Fields observed in the tested Codex request but not represented by the Web compatibility workflow may be discarded only by the explicit projector; they are never forwarded by object spread. Media, unsupported input item types, persistence, a conflicting tool choice, invalid function tools, or values outside the certified contract MUST fail closed. Namespace, built-in, remote, MCP, and app entries do not become callable Web tools. Acceptance or omission of compatibility metadata MUST NOT imply that an unsupported semantic effect was preserved.

Developer instructions and developer-role messages are projected into labeled sections of one visible user message. This transformation does **not** preserve native developer-over-user priority. Activation is consent to that semantic loss; diagnostics and UI MUST NOT describe the route as fully Responses-compatible.

The bridge MUST keep these values local and MUST NOT include them in browser-visible text:

- `client_metadata`;
- `prompt_cache_key`;
- bearer capabilities or loopback endpoint details;
- private provider tokens;
- native browser session, Codex thread, or Codex turn identifiers; and
- account or profile identifiers.

The visible projection uses a public random workflow alias and contains only the accepted content, protocol instructions, exact public tool manifest, current round, and round challenge. The implementation MUST build that projection from typed fields; it MUST NOT concatenate an unvalidated request object or log the resulting message.

### 4.2 Tool profile

The MVP derives one memory-only profile from the function-tool entries in the tested Codex request. It retains at most 32 function tools whose parameters fit the local certified, recursively closed JSON Schema subset, and it requires `exec_command` to be present. The exact ordered names, descriptions, strict flags, and schemas determine a dynamic profile version and manifest digest. A malformed or uncertifiable function entry rejects the request rather than being silently removed.

Namespace markers, built-in Web search, remote tools, MCP/apps, plugin-installation entries, image or audio input, and non-text tool results are not included in the callable Web manifest. Their presence in the broader Codex tool array does not grant the browser or bridge authority to run them. Adding a newly shaped function schema requires the local schema certifier and current-child contract fixtures to accept it.

Each tool schema MUST:

- have an object root;
- reject unknown properties recursively;
- contain no remote reference or executable transformation;
- fit the manifest limits in section 10; and
- fit the exact locally certified schema subset retained in the selected profile.

The manifest is the exact closed object `{ "parallelToolCalls": false, "profileVersion": string, "tools": [...] }`. It is canonicalized using the restricted RFC 8785 profile below and hashed with SHA-256. Its visible value has the form `sha256-` followed by the canonical unpadded base64url encoding of exactly 32 digest bytes. A decoder MUST reject non-zero padding bits or any decode/re-encode mismatch. Any parallel-call policy, profile version, tool, ordering, description, or schema change produces a different digest and invalidates the active workflow.

#### Canonical JSON profile

Manifest, request-prefix, and argument digests use RFC 8785 JSON Canonicalization Scheme (JCS) with these additional protocol restrictions:

- objects have only enumerable data properties and recursively sort decoded names by unsigned UTF-16 code units;
- arrays are dense, retain their original order, and have no additional properties;
- strings preserve their exact Unicode scalar values without normalization; a lone UTF-16 surrogate is invalid;
- the keys `__proto__`, `constructor`, and `prototype` are invalid at every object depth;
- numbers are finite IEEE 754 binary64 values, every integer is within JavaScript's safe-integer range, and an incoming number token must already equal its JCS/ECMAScript serialization; and
- canonical output contains no whitespace and is encoded as UTF-8 before hashing or byte measurement.

Values requiring a larger integer or decimal domain MUST be represented as strings by the certified tool schema. The codec never rounds a number, drops a key, invokes `toJSON` or an accessor, normalizes Unicode, or repairs an invalid value.

Cross-platform implementations MUST pass this vector:

```text
input:     {"z":3,"a":{"b":true,"a":"fixture"},"list":[null,0.1]}
canonical: {"a":{"a":"fixture","b":true},"list":[null,0.1],"z":3}
sha256:    R-bboQDPP1_0A6Qrjz_2XwV8xxQBv0QMWOLVVieGK6k
```

The digest line is unpadded base64url over the SHA-256 digest of the canonical UTF-8 bytes.

### 4.3 Continuation request

After the child completes a tool call, its continuation MUST preserve the exact canonical message prefix and derived tool profile. Codex sends cumulative function history: after the message prefix, the request contains alternating bridge-issued function-call items and matching function-call outputs. Every prior pair MUST match the workflow's cumulative-history digest, and the newly appended final pair MUST contain the exact pending call and its matching real `call_id`. The projector passes only that latest pair to the one-round `ResponsesServerV2` continuation boundary and advances the cumulative-history binding for the next round.

The model route, function-profile fingerprint, message prefix, cumulative call/output history, admitted child request metadata, and provider route MUST match the active workflow binding. Missing, reordered, duplicated, mutated, or additional call/output items fail closed as contract drift or `child_continuation_mismatch`.

Tool output is untrusted text. The bridge serializes it into a `tool_result` envelope, creates a fresh challenge for round `n + 1`, and submits it through the same owned conversation. It MUST NOT interpret output as protocol framing, silently truncate it, or submit it to a different document.

## 5. Memory-only binding record

For every active workflow, the bridge retains one immutable binding record containing:

- activation-lease identity and expiry;
- selected tab and main-frame `documentId`;
- browser `sessionId` and session generation;
- owned conversation path and first adapter-created user-message identity;
- catalog revision, browser model ID, and provider route;
- Codex thread and turn identity;
- canonical initial-request prefix and cumulative continuation-history digests;
- exact tool profile, canonical manifest, schemas, and manifest digest;
- public workflow alias, current round, and current challenge; and
- committed call state, real call ID, public call reference, tool name, argument digest, and result state.

Only the public workflow alias, round, challenge, manifest digest, public call reference, tool name, arguments, final text, and bounded tool result may appear in visible envelopes. The record is resolved by exact lookup; public values are never decoded into private route identity.

Before every composer mutation, the coordinator MUST revalidate the lease, document, session generation, conversation ownership, catalog revision, selected model, provider route, round, and manifest. The same ownership and route conditions remain mandatory while awaiting the response.

## 6. Browser-visible envelope

### 6.1 Framing

Every complete assistant response MUST have exactly this framing, using LF line endings:

```text
GSB/2 BEGIN
<one single-line JSON object>
GSB/2 END
```

There MUST be no leading or trailing byte, blank line, prose, Markdown fence, byte-order mark, CRLF sequence, or second JSON value. The JSON line MUST begin with `{` and end with `}` and MUST contain no literal newline.

Objects are closed schemas. Duplicate or prototype-sensitive keys, unknown keys, non-canonical or unsafe numbers, invalid escapes or Unicode, excessive nesting, and excessive node counts are invalid. Argument property order is not semantically significant. Valid arguments may be re-encoded only with the canonical profile above; no parser may otherwise normalize, repair, drop, or infer a tool name, command, path, or argument.

### 6.2 Tool proposal

```json
{
  "v": 2,
  "turn": "wt_exampleAlias0001",
  "round": 0,
  "challenge": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "manifestDigest": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "kind": "tool_call",
  "tool": "exec_command",
  "arguments": { "cmd": "example" }
}
```

Required exact keys:

- `v`: integer `2`;
- `turn`: `wt_` plus 16–96 base64url characters;
- `round`: integer from `0` through `31`; round `32` is reserved for a final response after the last admitted call;
- `challenge`: exactly 32 base64url characters, representing 192 random bits;
- `manifestDigest`: `sha256-` plus 43 unpadded base64url characters;
- `kind`: `tool_call`;
- `tool`: 1–64 characters from `A-Z`, `a-z`, `0-9`, `_`, or `-`; and
- `arguments`: a JSON object.

The current round accepts one tool proposal only. The bridge validates the exact turn alias, round, challenge, manifest digest, tool name, and argument schema before minting a real Responses `call_id`.

### 6.3 Final response

```json
{
  "v": 2,
  "turn": "wt_exampleAlias0001",
  "round": 1,
  "challenge": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "manifestDigest": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "kind": "final",
  "text": "Completed."
}
```

The base fields have the same constraints as a tool proposal except that a final response may use round `32`. The remaining exact keys are:

- `kind`: `final`; and
- `text`: bounded final assistant text.

A final envelope contains no tool proposal. Its `text` is returned as assistant output only after the entire envelope and current DOM binding validate.

### 6.4 Tool result

The bridge, never the model, serializes the continuation payload:

```json
{
  "v": 2,
  "kind": "tool_result",
  "turn": "wt_exampleAlias0001",
  "round": 1,
  "challenge": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "manifestDigest": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "callRef": "wc_exampleCallRef01",
  "tool": "exec_command",
  "ok": true,
  "output": "bounded result"
}
```

`callRef` is a public opaque alias with prefix `wc_`; it is not the real child-facing `call_id`. The round and challenge are fresh values for the next Web response. `ok` reflects the child-produced result status. `output` is JSON-escaped, bounded text and is never treated as envelope framing.

A tool proposal is permitted only in rounds `0` through `31`. Its result advances to rounds `1` through `32`; round `32` can contain only a final response. Thus the maximum 32nd call still has one bounded continuation/final round and cannot create an unrepresentable state.

## 7. Challenge semantics

The bridge generates a fresh 192-bit challenge for every submitted round. A challenge is bound to one workflow alias, round, document, route, manifest, and request state and is consumed by the first terminal parse attempt.

The challenge prevents accidental acceptance of a stale, cross-round, cross-turn, or replayed response. It does not authenticate the model, page, extension, or user because it is visible in the composer. A response with the correct challenge remains an untrusted model proposal and still requires every structural, route, schema, child-policy, approval, and sandbox check.

## 8. State machine

```text
disabled
  -> lease_active
  -> initial_request_bound
  -> round_submitted
  -> awaiting_assistant_envelope
  -> envelope_validated
       -> final_committed
       -> completed
       or
       -> tool_call_committed
       -> awaiting_child_continuation
       -> continuation_validated
       -> next_round_bound
       -> round_submitted

Any invalid transition -> failed_terminal
Explicit cancellation  -> cancelled_terminal
```

Normative invariants:

- Only one workflow and one submitted round may be active for a selected document.
- Only one unconsumed challenge and one pending tool call may exist.
- The full assistant DOM response is buffered before parsing; partial text cannot commit a final response or tool call.
- `tool_call_committed` is persisted in memory before the first function-call event is emitted to the child.
- A committed real `call_id` is never minted or emitted again.
- A continuation is accepted only while the exact committed call is pending.
- Every mismatch consumes the current challenge and moves to a terminal state.
- Terminal states do not retry, replay, reconnect, change model, select another tab, or fall back to native Codex.
- A new workflow requires a new public alias, binding record, and challenge.

## 9. Responses lifecycle mapping

For a validated `tool_call` envelope, the bridge:

1. validates the call against the immutable manifest and argument schema;
2. mints a real response item ID and `call_id`;
3. records `tool_call_committed`;
4. emits the standard Responses function-call item lifecycle to the official child; and
5. waits for the child’s matching continuation after any approval and execution lifecycle.

For a validated `final` envelope, the bridge emits one assistant output-text item and a completed response lifecycle.

Raw envelope bytes and partially streamed assistant content MUST NOT be emitted as trusted assistant or function-call events. A client request with `stream: true` still receives Responses events, but those events may arrive only after full DOM completion and validation. This intentional buffering is part of the security boundary.

The bridge never emits a successful function-call output on behalf of a failed, cancelled, rejected, or unavailable child tool. Approval requests and responses remain unchanged between the official child and its connected app-server client.

## 10. Limits

All byte limits are measured after UTF-8 encoding. Exceeding any limit fails closed; no value is truncated or repaired.

| Resource                             |   Limit |
| ------------------------------------ | ------: |
| Complete v2 envelope                 | 256 KiB |
| Tool arguments, canonical JSON       |  64 KiB |
| One tool result                      | 128 KiB |
| Aggregate tool results per workflow  | 512 KiB |
| Final response text                  | 192 KiB |
| JSON nesting depth                   |      32 |
| JSON structural nodes                |   4,096 |
| Assistant response rounds            |      33 |
| Tool calls per round                 |       1 |
| Tool calls per workflow              |      32 |
| Tool entries in a certified profile  |      32 |
| Canonical tool manifest              | 128 KiB |
| Complete visible composer projection | 256 KiB |

Existing Native Messaging frame, queue, request, response, timeout, and DOM output bounds continue to apply. If two limits differ, the smaller limit wins.

## 11. Failure codes

Failures are terminal unless a future specification marks a code retryable. Error messages exposed outside the trusted local boundary MUST be content-free and MUST NOT echo a prompt, assistant response, tool name, arguments, result, path, challenge, manifest, capability, endpoint, or route token.

| Code                            | Condition                                                                  |
| ------------------------------- | -------------------------------------------------------------------------- |
| `tool_protocol_not_activated`   | No valid user activation lease or matching agent route selection           |
| `unsupported_tool_profile`      | Function profile, tool, or schema is not locally certified                 |
| `tool_manifest_changed`         | Canonical manifest differs from the request-bound snapshot                 |
| `protocol_envelope_invalid`     | Framing, JSON, exact keys, or base schema is invalid                       |
| `protocol_envelope_too_large`   | Complete envelope exceeds its byte limit                                   |
| `protocol_json_duplicate_key`   | Any object contains a duplicate decoded key                                |
| `protocol_json_number_invalid`  | Number is non-canonical, non-finite, lossy, or an unsafe integer           |
| `protocol_json_string_invalid`  | String or key contains invalid Unicode such as a lone surrogate            |
| `protocol_json_unsafe_key`      | Object contains a prototype-sensitive key                                  |
| `protocol_json_too_deep`        | JSON nesting exceeds the depth limit                                       |
| `protocol_json_too_complex`     | JSON node count exceeds the complexity limit                               |
| `protocol_arguments_too_large`  | Canonical arguments exceed their byte limit                                |
| `protocol_final_text_too_large` | Final text exceeds its byte limit                                          |
| `protocol_turn_mismatch`        | Public workflow alias does not match the active binding                    |
| `protocol_round_mismatch`       | Round is stale, future, repeated, or otherwise unexpected                  |
| `protocol_challenge_mismatch`   | Challenge is missing, stale, replayed, or not current                      |
| `protocol_manifest_mismatch`    | Envelope digest does not match the immutable manifest                      |
| `protocol_tool_unknown`         | Tool name is not in the exact certified profile                            |
| `protocol_arguments_invalid`    | Arguments fail the exact tool schema                                       |
| `child_continuation_mismatch`   | Child prefix, call, output, route, or local metadata binding differs       |
| `tool_result_too_large`         | One or aggregate child result exceeds its budget                           |
| `tool_budget_exhausted`         | Round, call, manifest, composer, or aggregate workflow budget is exhausted |
| `browser_state_changed`         | Document, ownership, path, model, catalog, session, or route changed       |
| `tool_loop_incomplete`          | Web or child lifecycle ended while a committed call remained unresolved    |
| `turn_cancelled`                | The user, app-server client, transport, or shutdown cancelled the workflow |

Parser-specific codes may be retained in local typed results, but user-facing messages remain generic and content-free.

## 12. Cancellation and teardown

Cancellation stops admission of new rounds immediately and asks the official child to cancel pending local work through its supported lifecycle. The DOM adapter may request Web cancellation only by clicking a currently visible, verified Stop control.

The bridge cannot prove that a remote Web generation stopped after transport or document loss. It MUST report the ambiguity without replaying the prompt. A tool call committed before cancellation remains recorded and cannot be emitted again; whether already-started local work stops is determined by the official child and its sandbox lifecycle.

Disconnect before call commit produces no function-call event. Disconnect after call commit produces no second event and no automatic continuation. All activation and workflow bindings are discarded on bridge shutdown.

## 13. Threat and privacy analysis

| Threat                              | Required response                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Prompt injection or forged envelope | Treat output as an untrusted proposal; validate exact schema and defer authority to child policy, approval, and sandbox |
| Replay or stale DOM delivery        | Single-use challenge, exact round and binding, terminal failure after first parse attempt                               |
| Tool or route confusion             | Immutable manifest and exact document/session/catalog/model/provider bindings                                           |
| Duplicate execution                 | Commit before SSE, one pending call, real call ID minted locally, no retry or replay                                    |
| Malicious tool output               | Bridge-owned JSON serialization, bounded text, fresh next-round challenge; never parse output as framing                |
| DOM or model drift                  | Revalidate before mutation and while awaiting output; fail terminal on ambiguity                                        |
| Credential extraction               | No cookie, storage, debugger, page-state, profile, or undocumented backend access                                       |
| Local data disclosure               | Explicit activation disclosure; bounded visible projection; no claim of ephemeral or zero-retention handling            |
| Diagnostic leakage                  | Allowlisted event codes and counts only; no raw protocol content, identities, or local paths                            |

Developer context, source excerpts, commands, and child-produced tool output sent through v2 become visible ChatGPT conversation content and may be retained under the user’s account settings. The bridge cannot reliably redact arbitrary secrets without changing tool semantics. The user must be informed before activation, and real account content is excluded from automated fixtures.

The challenge, workflow alias, call reference, and manifest digest are not credentials. They MUST NOT be described as authentication or used to authorize execution.

## 14. MVP activation and release gates

The runtime advertises a Web Agent entry only when all per-document activation gates pass:

- the user connected one exact supported main-frame document and accepted the current disclosure;
- the extension reports a current active lease through authenticated Native Messaging v2;
- the coordinator can bind the exact session generation, document, conversation ownership, catalog revision, visible model, and provider route;
- the initial surface is a fresh `/` conversation with no visible transcript;
- the provider request matches the current Codex contract projection and every retained function tool has a certified closed schema; and
- no text or agent turn is already active for the selected browser session.

Repository verification covers the request and cumulative-continuation projector, strict codecs and canonicalization, adversarial envelope and schema cases, at-most-once commit, activation expiry and invalidation, authenticated agent transport, one-shot page permits, and the production DOM driver on synthetic Chrome documents. Passing these gates enables only the unsigned personal-use MVP.

The following remain release and compatibility gates rather than implemented guarantees:

- a packaged extension and Native Host exercised end to end through a real Chrome profile;
- a successful current-account ChatGPT turn and IDE coding workflow;
- stable or localized ChatGPT DOM compatibility;
- independent security review, protected installation, code signing, and a production extension identity; and
- a published supported-version policy beyond the exact development snapshot.

The absence of those certifications MUST remain visible in the README, security policy, and compatibility matrix. A synthetic fixture or successful personal run is not a public support claim.

## 15. Current status

The personal-use MVP connects the v2 path end to end in source: an `agent-v2` provider route dispatches to the current-Codex projector, `ResponsesServerV2`, `ResponsesAgentRuntime`, `ResponsesV2AgentSessionAdapter`, and `AgentSessionCoordinator`; the browser boundary revalidates the active lease; Native Messaging and page protocol v2 carry one-shot agent turns; the production DOM driver returns exact complete text; and the catalog publishes `Web Agent · …` only while the exact lease is active.

The official Codex child receives the validated function-call lifecycle, owns any approval and sandbox behavior, executes the local tool, and sends the cumulative continuation. The bridge keeps pending workflow and continuation fingerprints in bounded memory with expiry and consumes a pending call before validating its continuation so a failed or replayed request cannot execute it twice.

The visible capability snapshot still reports `toolCalls: false` for the separate text-turn schema. Agent availability is represented by the authenticated activation snapshot and revision-bound `agent-v2` catalog route, not by widening the v1 capability field.

Automated Chrome coverage uses a synthetic local document and does not sign in, load the packaged extension, contact ChatGPT, or certify the current real-account UI. The project therefore remains an unsigned pre-alpha personal-use MVP even though the v2 source path is active.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
