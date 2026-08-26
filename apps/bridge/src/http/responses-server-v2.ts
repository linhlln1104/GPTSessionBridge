import { createHash, randomBytes } from "node:crypto";

import {
  MAX_TOOL_WORKFLOW_ARGUMENT_BYTES,
  MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES,
  MAX_TOOL_WORKFLOW_JSON_DEPTH,
  MAX_TOOL_WORKFLOW_JSON_NODES,
  MAX_TOOL_WORKFLOW_RESULT_BYTES,
  canonicalizeToolWorkflowJson,
  type JsonObject,
  type JsonValue,
} from "@gpt-session-bridge/protocol";

import {
  isCertifiedToolParametersSchema,
  matchesCertifiedToolArguments,
} from "../tooling/certified-tool-schema.js";

/**
 * This module is an inactive protocol-v2 boundary. It deliberately has no
 * listener, browser transport, approval, sandbox, or tool-execution API.
 * Runtime activation remains a separate release decision under ADR 0005.
 */

export const MAX_RESPONSES_V2_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSES_V2_PREFIX_BYTES = 256 * 1024;
export const MAX_RESPONSES_V2_MANIFEST_BYTES = 128 * 1024;
export const MAX_RESPONSES_V2_INSTRUCTIONS_BYTES = 64 * 1024;
export const MAX_RESPONSES_V2_INPUT_BYTES = 128 * 1024;
export const MAX_RESPONSES_V2_CLIENT_METADATA_BYTES = 16 * 1024;
export const MAX_RESPONSES_V2_INPUT_ITEMS = 64;
export const MAX_RESPONSES_V2_TOOL_ENTRIES = 32;
export const MAX_RESPONSES_V2_EMITTED_TOOL_CALLS = 4_096;

const MAX_MODEL_CHARACTERS = 256;
const MAX_PROFILE_VERSION_CHARACTERS = 64;
const MAX_REASONING_EFFORT_CHARACTERS = 64;
const MAX_PROMPT_CACHE_KEY_CHARACTERS = 256;
const MAX_TOOL_NAME_CHARACTERS = 64;
const MAX_TOOL_DESCRIPTION_BYTES = 4 * 1024;
const ID_ENTROPY_BYTES = 18;
const textEncoder = new TextEncoder();
const opaqueTextPattern = /^[A-Za-z0-9._:/-]+$/u;
const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/u;
const itemIdPattern = /^fc_[A-Za-z0-9_-]{16,128}$/u;
const callIdPattern = /^call_[A-Za-z0-9_-]{16,128}$/u;
const callReferencePattern = /^wc_[A-Za-z0-9_-]{16,96}$/u;
const responseIdPattern = /^resp_[A-Za-z0-9_-]{16,128}$/u;
const messageIdPattern = /^msg_[A-Za-z0-9_-]{16,128}$/u;
const unsafeJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

const INITIAL_REQUEST_KEYS = new Set([
  "client_metadata",
  "include",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "tool_choice",
  "tools",
]);
const MESSAGE_KEYS = new Set(["content", "role", "type"]);
const INPUT_TEXT_KEYS = new Set(["text", "type"]);
const REASONING_KEYS = new Set(["effort"]);
const FUNCTION_TOOL_KEYS = new Set(["description", "name", "parameters", "strict", "type"]);
const FUNCTION_CALL_KEYS = new Set(["arguments", "call_id", "id", "name", "status", "type"]);
const FUNCTION_OUTPUT_KEYS = new Set(["call_id", "output", "type"]);
const COMMITTED_CALL_KEYS = new Set([
  "arguments",
  "argumentsJson",
  "callId",
  "callRef",
  "itemId",
  "kind",
  "tool",
]);
const FINAL_OUTCOME_KEYS = new Set(["kind", "text"]);

export const RESPONSES_V2_BOUNDARY_ERROR_CODES = [
  "v2_request_invalid",
  "unsupported_tool_profile",
  "tool_manifest_changed",
  "child_continuation_mismatch",
  "validated_outcome_invalid",
] as const;

export type ResponsesV2BoundaryErrorCode = (typeof RESPONSES_V2_BOUNDARY_ERROR_CODES)[number];

export interface ResponsesV2BoundaryError {
  readonly code: ResponsesV2BoundaryErrorCode;
  readonly message: string;
}

export type ResponsesV2BoundaryResult<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ error: ResponsesV2BoundaryError; ok: false }>;

export interface ResponsesV2FunctionTool {
  readonly description: string;
  readonly name: string;
  readonly parameters: JsonObject;
  readonly strict: true;
  readonly type: "function";
}

export interface ResponsesV2CertifiedToolProfile {
  /** Version is supplied by a tested Codex-child contract, never inferred from tool names. */
  readonly profileVersion: string;
  readonly manifestDigest: string;
  readonly parallelToolCalls: false;
  readonly tools: readonly ResponsesV2FunctionTool[];
}

export interface ResponsesV2InputTextPart {
  readonly text: string;
  readonly type: "input_text";
}

export interface ResponsesV2TextMessage {
  readonly content: readonly ResponsesV2InputTextPart[];
  readonly role: "developer" | "user";
}

export interface ResponsesV2InitialRequest {
  readonly kind: "initial";
  readonly canonicalManifest: string;
  readonly canonicalRequestPrefix: string;
  readonly clientMetadata?: JsonObject;
  readonly inputPrefix: readonly JsonValue[];
  readonly instructions?: string;
  readonly manifestDigest: string;
  readonly messages: readonly ResponsesV2TextMessage[];
  readonly model: string;
  readonly parallelToolCalls: boolean;
  readonly profileVersion: string;
  readonly promptCacheKey?: string;
  readonly reasoningEffort: string;
  readonly requestPrefix: JsonObject;
  readonly requestPrefixDigest: string;
  readonly stream: boolean;
  readonly tools: readonly ResponsesV2FunctionTool[];
}

export interface ResponsesV2CommittedToolCall {
  readonly arguments: JsonObject;
  readonly argumentsJson: string;
  readonly callId: string;
  readonly callRef: string;
  readonly itemId: string;
  readonly kind: "tool_call";
  readonly tool: string;
}

export interface ResponsesV2ContinuationBinding {
  readonly committedCall: ResponsesV2CommittedToolCall;
  readonly initialRequest: ResponsesV2InitialRequest;
}

export interface ResponsesV2FunctionCallItem {
  readonly arguments: string;
  readonly call_id: string;
  readonly id: string;
  readonly name: string;
  readonly status: "completed";
  readonly type: "function_call";
}

export interface ResponsesV2FunctionCallOutputItem {
  readonly call_id: string;
  readonly output: string;
  readonly type: "function_call_output";
}

export interface ResponsesV2ContinuationRequest {
  readonly kind: "continuation";
  readonly call: ResponsesV2FunctionCallItem;
  readonly canonicalRequestPrefix: string;
  readonly functionCallOutput: ResponsesV2FunctionCallOutputItem;
  readonly initialRequest: ResponsesV2InitialRequest;
  readonly inputSuffix: readonly [ResponsesV2FunctionCallItem, ResponsesV2FunctionCallOutputItem];
  readonly requestPrefixDigest: string;
}

export type ResponsesV2AdmittedRequest = ResponsesV2InitialRequest | ResponsesV2ContinuationRequest;

export type ResponsesV2ValidatedOutcome =
  Readonly<{ kind: "final"; text: string }> | ResponsesV2CommittedToolCall;

/**
 * Structural integration contract for AgentSessionCoordinator. Implementations
 * validate state and commit calls, while the official Codex child retains all
 * approval, sandbox, and execution responsibility.
 */
export interface ResponsesV2AgentSessionPort {
  startWorkflow(request: ResponsesV2InitialRequest): Promise<ResponsesV2ValidatedOutcome>;
  continueWorkflow(request: ResponsesV2ContinuationRequest): Promise<ResponsesV2ValidatedOutcome>;
}

export interface ResponsesV2IdentitySource {
  createMessageId(): string;
  createResponseId(): string;
  nowEpochSeconds(): number;
}

export interface ResponsesV2OutputTextPart {
  readonly annotations: readonly [];
  readonly text: string;
  readonly type: "output_text";
}

export interface ResponsesV2OutputMessage {
  readonly content: readonly ResponsesV2OutputTextPart[];
  readonly id: string;
  readonly role: "assistant";
  readonly status: "completed" | "in_progress";
  readonly type: "message";
}

export type ResponsesV2OutputFunctionCall = ResponsesV2FunctionCallItem;

export type ResponsesV2OutputItem = ResponsesV2OutputFunctionCall | ResponsesV2OutputMessage;

export interface ResponsesV2ResponseObject {
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly error: null;
  readonly id: string;
  readonly incomplete_details: null;
  readonly instructions: string | null;
  readonly max_output_tokens: null;
  readonly metadata: Readonly<Record<string, never>>;
  readonly model: string;
  readonly object: "response";
  readonly output: readonly ResponsesV2OutputItem[];
  readonly parallel_tool_calls: boolean;
  readonly previous_response_id: null;
  readonly reasoning: Readonly<{ effort: string; summary: null }>;
  readonly status: "completed" | "in_progress";
  readonly store: false;
  readonly temperature: null;
  readonly text: Readonly<{ format: Readonly<{ type: "text" }> }>;
  readonly tool_choice: "auto";
  readonly tools: readonly ResponsesV2FunctionTool[];
  readonly top_p: null;
  readonly truncation: "disabled";
  readonly usage: null;
}

export const RESPONSES_V2_SSE_EVENT_TYPES = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "response.completed",
] as const;

export type ResponsesV2SseEventType = (typeof RESPONSES_V2_SSE_EVENT_TYPES)[number];

export interface ResponsesV2SseEvent {
  readonly sequence_number: number;
  readonly type: ResponsesV2SseEventType;
  readonly [key: string]: unknown;
}

export interface ResponsesV2Lifecycle {
  readonly events: readonly ResponsesV2SseEvent[];
  readonly response: ResponsesV2ResponseObject;
}

export interface ResponsesServerV2Options {
  readonly identitySource?: ResponsesV2IdentitySource;
  readonly maxRequestBytes?: number;
  readonly toolProfile: ResponsesV2CertifiedToolProfile;
}

interface ParsedRequestCommon {
  readonly body: JsonObject;
  readonly input: JsonValue[];
  readonly model: string;
  readonly parallelToolCalls: boolean;
  readonly reasoningEffort: string;
  readonly stream: boolean;
  readonly tools: ResponsesV2FunctionTool[];
}

interface ResponseIdentity {
  readonly createdAt: number;
  readonly messageId?: string;
  readonly responseId: string;
}

export class ResponsesServerV2 {
  readonly #canonicalManifest: string;
  readonly #canonicalTools: string;
  readonly #continuationEligibleCallIds = new Set<string>();
  readonly #emittedToolCallIds = new Set<string>();
  readonly #identitySource: ResponsesV2IdentitySource;
  readonly #manifestDigest: string;
  readonly #maxRequestBytes: number;
  readonly #parallelToolCalls: boolean;
  readonly #profileVersion: string;
  readonly #tools: readonly ResponsesV2FunctionTool[];

  public constructor(options: ResponsesServerV2Options) {
    const maxRequestBytes = options.maxRequestBytes ?? MAX_RESPONSES_V2_REQUEST_BYTES;
    if (
      !Number.isSafeInteger(maxRequestBytes) ||
      maxRequestBytes < 1 ||
      maxRequestBytes > MAX_RESPONSES_V2_REQUEST_BYTES
    ) {
      throw new RangeError("Invalid Responses v2 request limit.");
    }
    if (!isBoundedOpaqueText(options.toolProfile.profileVersion, MAX_PROFILE_VERSION_CHARACTERS)) {
      throw new RangeError("Invalid Responses v2 profile.");
    }
    const configuredParallelToolCalls: unknown = options.toolProfile.parallelToolCalls;
    if (configuredParallelToolCalls !== false) {
      throw new RangeError("Invalid Responses v2 profile.");
    }

    let tools: ResponsesV2FunctionTool[] | undefined;
    try {
      tools = parseFunctionTools(cloneCanonicalJson(options.toolProfile.tools));
    } catch {
      throw new RangeError("Invalid Responses v2 profile.");
    }
    if (tools === undefined || tools.length === 0 || !tools.every(hasClosedToolSchema)) {
      throw new RangeError("Invalid Responses v2 profile.");
    }
    const canonicalTools = canonicalizeToolWorkflowJson(tools as unknown as JsonValue);
    const canonicalManifest = canonicalizeToolWorkflowJson({
      parallelToolCalls: false,
      profileVersion: options.toolProfile.profileVersion,
      tools: cloneCanonicalJson(tools),
    });
    if (encodedBytes(canonicalManifest) > MAX_RESPONSES_V2_MANIFEST_BYTES) {
      throw new RangeError("Invalid Responses v2 profile.");
    }
    const manifestDigest = digestCanonical(canonicalManifest);
    if (options.toolProfile.manifestDigest !== manifestDigest) {
      throw new RangeError("Invalid Responses v2 profile.");
    }

    const identitySource = options.identitySource ?? defaultIdentitySource;
    if (
      typeof identitySource.createMessageId !== "function" ||
      typeof identitySource.createResponseId !== "function" ||
      typeof identitySource.nowEpochSeconds !== "function"
    ) {
      throw new RangeError("Invalid Responses v2 identity source.");
    }

    this.#canonicalManifest = canonicalManifest;
    this.#canonicalTools = canonicalTools;
    this.#identitySource = identitySource;
    this.#manifestDigest = manifestDigest;
    this.#maxRequestBytes = maxRequestBytes;
    this.#parallelToolCalls = configuredParallelToolCalls;
    this.#profileVersion = options.toolProfile.profileVersion;
    this.#tools = deepFreeze(tools);
  }

  public admitInitialRequest(body: string): ResponsesV2BoundaryResult<ResponsesV2InitialRequest> {
    const parsed = this.#parseCommon(body);
    if (!parsed.ok) {
      return parsed;
    }
    if (
      canonicalizeToolWorkflowJson(parsed.value.tools as unknown as JsonValue) !==
      this.#canonicalTools
    ) {
      return boundaryFailure("tool_manifest_changed");
    }

    const messages = parseMessagePrefix(parsed.value.input);
    if (messages === undefined) {
      return boundaryFailure("v2_request_invalid");
    }
    const inputBytes = encodedCanonicalBytes(parsed.value.input);
    if (inputBytes > MAX_RESPONSES_V2_INPUT_BYTES) {
      return boundaryFailure("v2_request_invalid");
    }

    const canonicalRequestPrefix = canonicalizeToolWorkflowJson(parsed.value.body);
    if (encodedBytes(canonicalRequestPrefix) > MAX_RESPONSES_V2_PREFIX_BYTES) {
      return boundaryFailure("v2_request_invalid");
    }
    const requestPrefix = cloneCanonicalJson(parsed.value.body) as JsonObject;
    const inputPrefix = cloneCanonicalJson(parsed.value.input) as JsonValue[];
    const clientMetadata = readOptionalObject(parsed.value.body, "client_metadata");
    const instructions = readOptionalString(parsed.value.body, "instructions");
    const promptCacheKey = readOptionalString(parsed.value.body, "prompt_cache_key");

    return boundarySuccess(
      deepFreeze({
        kind: "initial" as const,
        canonicalManifest: this.#canonicalManifest,
        canonicalRequestPrefix,
        ...(clientMetadata === undefined
          ? {}
          : { clientMetadata: cloneCanonicalJson(clientMetadata) as JsonObject }),
        inputPrefix,
        ...(instructions === undefined ? {} : { instructions }),
        manifestDigest: this.#manifestDigest,
        messages,
        model: parsed.value.model,
        parallelToolCalls: parsed.value.parallelToolCalls,
        profileVersion: this.#profileVersion,
        ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
        reasoningEffort: parsed.value.reasoningEffort,
        requestPrefix,
        requestPrefixDigest: digestCanonical(canonicalRequestPrefix),
        stream: parsed.value.stream,
        tools: this.#tools,
      }),
    );
  }

  public admitContinuationRequest(
    body: string,
    binding: ResponsesV2ContinuationBinding,
  ): ResponsesV2BoundaryResult<ResponsesV2ContinuationRequest> {
    const expectedCall = parseCommittedCall(binding.committedCall, this.#tools);
    if (
      expectedCall === undefined ||
      !this.#continuationEligibleCallIds.delete(expectedCall.callId) ||
      !this.#isCurrentInitialRequest(binding.initialRequest)
    ) {
      return boundaryFailure("child_continuation_mismatch");
    }

    const parsed = this.#parseCommon(body);
    if (!parsed.ok) {
      return boundaryFailure("child_continuation_mismatch");
    }
    if (
      canonicalizeToolWorkflowJson(parsed.value.tools as unknown as JsonValue) !==
      this.#canonicalTools
    ) {
      return boundaryFailure("child_continuation_mismatch");
    }

    const prefixLength = binding.initialRequest.inputPrefix.length;
    if (parsed.value.input.length !== prefixLength + 2) {
      return boundaryFailure("child_continuation_mismatch");
    }
    const prefixInput = parsed.value.input.slice(0, prefixLength);
    if (parseMessagePrefix(prefixInput) === undefined) {
      return boundaryFailure("child_continuation_mismatch");
    }
    const requestPrefix = replaceInput(parsed.value.body, prefixInput);
    const canonicalRequestPrefix = canonicalizeToolWorkflowJson(requestPrefix);
    if (canonicalRequestPrefix !== binding.initialRequest.canonicalRequestPrefix) {
      return boundaryFailure("child_continuation_mismatch");
    }

    const call = parseFunctionCallItem(parsed.value.input[prefixLength]);
    const output = parseFunctionCallOutputItem(parsed.value.input[prefixLength + 1]);
    if (call === undefined || output === undefined) {
      return boundaryFailure("child_continuation_mismatch");
    }
    const expectedFunctionCall = createFunctionCallItem(expectedCall);
    if (
      canonicalizeToolWorkflowJson(call as unknown as JsonValue) !==
        canonicalizeToolWorkflowJson(expectedFunctionCall as unknown as JsonValue) ||
      output.call_id !== expectedCall.callId ||
      encodedBytes(output.output) > MAX_TOOL_WORKFLOW_RESULT_BYTES
    ) {
      return boundaryFailure("child_continuation_mismatch");
    }

    const frozenCall = deepFreeze(call);
    const frozenOutput = deepFreeze(output);
    return boundarySuccess(
      deepFreeze({
        kind: "continuation" as const,
        call: frozenCall,
        canonicalRequestPrefix,
        functionCallOutput: frozenOutput,
        initialRequest: binding.initialRequest,
        inputSuffix: [frozenCall, frozenOutput] as const,
        requestPrefixDigest: binding.initialRequest.requestPrefixDigest,
      }),
    );
  }

  public createLifecycle(
    request: ResponsesV2AdmittedRequest,
    outcome: ResponsesV2ValidatedOutcome,
  ): ResponsesV2BoundaryResult<ResponsesV2Lifecycle> {
    const initial = request.kind === "initial" ? request : request.initialRequest;
    if (!this.#isCurrentInitialRequest(initial)) {
      return boundaryFailure("validated_outcome_invalid");
    }

    const finalOutcome = parseFinalOutcome(outcome);
    if (finalOutcome !== undefined) {
      const identity = this.#createIdentity(true);
      return identity === undefined
        ? boundaryFailure("validated_outcome_invalid")
        : boundarySuccess(createFinalLifecycle(initial, identity, finalOutcome.text));
    }

    const committedCall = parseCommittedCall(outcome, this.#tools);
    if (
      committedCall === undefined ||
      this.#emittedToolCallIds.has(committedCall.callId) ||
      this.#emittedToolCallIds.size >= MAX_RESPONSES_V2_EMITTED_TOOL_CALLS
    ) {
      return boundaryFailure("validated_outcome_invalid");
    }
    // Consume before identity creation so an ambiguous failure cannot replay a call.
    this.#emittedToolCallIds.add(committedCall.callId);
    const identity = this.#createIdentity(false);
    if (identity === undefined) {
      return boundaryFailure("validated_outcome_invalid");
    }
    this.#continuationEligibleCallIds.add(committedCall.callId);
    return boundarySuccess(createToolCallLifecycle(initial, identity, committedCall));
  }

  #createIdentity(needsMessageId: boolean): ResponseIdentity | undefined {
    try {
      const responseId = this.#identitySource.createResponseId();
      const createdAt = this.#identitySource.nowEpochSeconds();
      const messageId = needsMessageId ? this.#identitySource.createMessageId() : undefined;
      if (
        !responseIdPattern.test(responseId) ||
        !Number.isSafeInteger(createdAt) ||
        createdAt < 0 ||
        (messageId !== undefined && !messageIdPattern.test(messageId))
      ) {
        return undefined;
      }
      return Object.freeze({
        createdAt,
        responseId,
        ...(messageId === undefined ? {} : { messageId }),
      });
    } catch {
      return undefined;
    }
  }

  #isCurrentInitialRequest(request: ResponsesV2InitialRequest): boolean {
    try {
      if (
        request.profileVersion !== this.#profileVersion ||
        request.manifestDigest !== this.#manifestDigest ||
        request.canonicalManifest !== this.#canonicalManifest ||
        canonicalizeToolWorkflowJson(request.tools as unknown as JsonValue) !==
          this.#canonicalTools ||
        canonicalizeToolWorkflowJson(request.requestPrefix) !== request.canonicalRequestPrefix ||
        digestCanonical(request.canonicalRequestPrefix) !== request.requestPrefixDigest
      ) {
        return false;
      }
      const reparsed = this.#parseCommon(request.canonicalRequestPrefix);
      if (!reparsed.ok) {
        return false;
      }
      const messages = parseMessagePrefix(reparsed.value.input);
      if (messages === undefined) {
        return false;
      }
      const metadata = readOptionalObject(reparsed.value.body, "client_metadata");
      return (
        canonicalizeToolWorkflowJson(reparsed.value.tools as unknown as JsonValue) ===
          this.#canonicalTools &&
        reparsed.value.model === request.model &&
        reparsed.value.parallelToolCalls === request.parallelToolCalls &&
        reparsed.value.reasoningEffort === request.reasoningEffort &&
        reparsed.value.stream === request.stream &&
        canonicalizeToolWorkflowJson(reparsed.value.input) ===
          canonicalizeToolWorkflowJson(request.inputPrefix as JsonValue) &&
        canonicalizeToolWorkflowJson(messages as unknown as JsonValue) ===
          canonicalizeToolWorkflowJson(request.messages as unknown as JsonValue) &&
        readOptionalString(reparsed.value.body, "instructions") === request.instructions &&
        readOptionalString(reparsed.value.body, "prompt_cache_key") === request.promptCacheKey &&
        sameOptionalJsonObject(metadata, request.clientMetadata)
      );
    } catch {
      return false;
    }
  }

  #parseCommon(body: string): ResponsesV2BoundaryResult<ParsedRequestCommon> {
    const value = parseStrictJsonObject(body, this.#maxRequestBytes);
    if (value === undefined || !hasOnlyKeys(value, INITIAL_REQUEST_KEYS)) {
      return boundaryFailure("v2_request_invalid");
    }
    if (!isBoundedOpaqueText(value["model"], MAX_MODEL_CHARACTERS)) {
      return boundaryFailure("v2_request_invalid");
    }
    if (!Array.isArray(value["input"]) || value["input"].length === 0) {
      return boundaryFailure("v2_request_invalid");
    }
    if (value["input"].length > MAX_RESPONSES_V2_INPUT_ITEMS + 2) {
      return boundaryFailure("v2_request_invalid");
    }
    if (value["store"] !== false || typeof value["stream"] !== "boolean") {
      return boundaryFailure("v2_request_invalid");
    }
    if (
      value["parallel_tool_calls"] !== this.#parallelToolCalls ||
      value["tool_choice"] !== "auto"
    ) {
      return boundaryFailure("v2_request_invalid");
    }
    if (
      value["include"] !== undefined &&
      (!Array.isArray(value["include"]) || value["include"].length !== 0)
    ) {
      return boundaryFailure("v2_request_invalid");
    }
    if (
      value["instructions"] !== undefined &&
      !isBoundedUnicodeText(value["instructions"], MAX_RESPONSES_V2_INSTRUCTIONS_BYTES)
    ) {
      return boundaryFailure("v2_request_invalid");
    }
    if (
      value["prompt_cache_key"] !== undefined &&
      !isBoundedOpaqueText(value["prompt_cache_key"], MAX_PROMPT_CACHE_KEY_CHARACTERS)
    ) {
      return boundaryFailure("v2_request_invalid");
    }
    if (
      value["client_metadata"] !== undefined &&
      (!isJsonObject(value["client_metadata"]) ||
        encodedCanonicalBytes(value["client_metadata"]) > MAX_RESPONSES_V2_CLIENT_METADATA_BYTES)
    ) {
      return boundaryFailure("v2_request_invalid");
    }

    const reasoningEffort = parseReasoningEffort(value["reasoning"]);
    const tools = parseFunctionTools(value["tools"]);
    if (reasoningEffort === undefined || tools === undefined || tools.length === 0) {
      return boundaryFailure("unsupported_tool_profile");
    }

    return boundarySuccess(
      Object.freeze({
        body: value,
        input: value["input"],
        model: value["model"],
        parallelToolCalls: value["parallel_tool_calls"],
        reasoningEffort,
        stream: value["stream"],
        tools,
      }),
    );
  }
}

function createFinalLifecycle(
  request: ResponsesV2InitialRequest,
  identity: ResponseIdentity,
  text: string,
): ResponsesV2Lifecycle {
  const messageId = identity.messageId;
  if (messageId === undefined) {
    throw new Error("Responses v2 final identity is incomplete.");
  }
  const part = deepFreeze({ annotations: [] as const, text, type: "output_text" as const });
  const pendingPart = deepFreeze({
    annotations: [] as const,
    text: "",
    type: "output_text" as const,
  });
  const pendingMessage = deepFreeze({
    content: [] as const,
    id: messageId,
    role: "assistant" as const,
    status: "in_progress" as const,
    type: "message" as const,
  });
  const message = deepFreeze({
    content: [part],
    id: messageId,
    role: "assistant" as const,
    status: "completed" as const,
    type: "message" as const,
  });
  const progress = createResponseObject(request, identity, "in_progress", []);
  const completed = createResponseObject(request, identity, "completed", [message]);
  return deepFreeze({
    events: sequenceEvents([
      { response: progress, type: "response.created" },
      { response: progress, type: "response.in_progress" },
      {
        item: pendingMessage,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.output_item.added",
      },
      {
        content_index: 0,
        item_id: messageId,
        output_index: 0,
        part: pendingPart,
        response_id: identity.responseId,
        type: "response.content_part.added",
      },
      {
        content_index: 0,
        delta: text,
        item_id: messageId,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.output_text.delta",
      },
      {
        content_index: 0,
        item_id: messageId,
        output_index: 0,
        response_id: identity.responseId,
        text,
        type: "response.output_text.done",
      },
      {
        content_index: 0,
        item_id: messageId,
        output_index: 0,
        part,
        response_id: identity.responseId,
        type: "response.content_part.done",
      },
      {
        item: message,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.output_item.done",
      },
      { response: completed, type: "response.completed" },
    ]),
    response: completed,
  });
}

function createToolCallLifecycle(
  request: ResponsesV2InitialRequest,
  identity: ResponseIdentity,
  committedCall: ResponsesV2CommittedToolCall,
): ResponsesV2Lifecycle {
  const completedCall = createFunctionCallItem(committedCall);
  const pendingCall = deepFreeze({
    ...completedCall,
    arguments: "",
    status: "in_progress" as const,
  });
  const progress = createResponseObject(request, identity, "in_progress", []);
  const completed = createResponseObject(request, identity, "completed", [completedCall]);
  return deepFreeze({
    events: sequenceEvents([
      { response: progress, type: "response.created" },
      { response: progress, type: "response.in_progress" },
      {
        item: pendingCall,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.output_item.added",
      },
      {
        delta: committedCall.argumentsJson,
        item_id: committedCall.itemId,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.function_call_arguments.delta",
      },
      {
        arguments: committedCall.argumentsJson,
        item_id: committedCall.itemId,
        name: committedCall.tool,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.function_call_arguments.done",
      },
      {
        item: completedCall,
        output_index: 0,
        response_id: identity.responseId,
        type: "response.output_item.done",
      },
      { response: completed, type: "response.completed" },
    ]),
    response: completed,
  });
}

function createResponseObject(
  request: ResponsesV2InitialRequest,
  identity: ResponseIdentity,
  status: "completed" | "in_progress",
  output: readonly ResponsesV2OutputItem[],
): ResponsesV2ResponseObject {
  return deepFreeze({
    completed_at: status === "completed" ? identity.createdAt : null,
    created_at: identity.createdAt,
    error: null,
    id: identity.responseId,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: null,
    metadata: {},
    model: request.model,
    object: "response" as const,
    output,
    parallel_tool_calls: request.parallelToolCalls,
    previous_response_id: null,
    reasoning: { effort: request.reasoningEffort, summary: null },
    status,
    store: false as const,
    temperature: null,
    text: { format: { type: "text" as const } },
    tool_choice: "auto" as const,
    tools: request.tools,
    top_p: null,
    truncation: "disabled" as const,
    usage: null,
  });
}

function sequenceEvents(
  events: readonly (Readonly<Record<string, unknown>> & {
    readonly type: ResponsesV2SseEventType;
  })[],
): readonly ResponsesV2SseEvent[] {
  return events.map((event, sequenceNumber) =>
    deepFreeze({ ...event, sequence_number: sequenceNumber }),
  );
}

function parseMessagePrefix(
  value: readonly JsonValue[],
): readonly ResponsesV2TextMessage[] | undefined {
  if (value.length === 0 || value.length > MAX_RESPONSES_V2_INPUT_ITEMS) {
    return undefined;
  }
  const messages: ResponsesV2TextMessage[] = [];
  let hasUserMessage = false;
  for (const item of value) {
    if (!isJsonObject(item) || !hasOnlyKeys(item, MESSAGE_KEYS)) {
      return undefined;
    }
    if (
      (item["role"] !== "developer" && item["role"] !== "user") ||
      (item["type"] !== undefined && item["type"] !== "message")
    ) {
      return undefined;
    }
    const parts = parseTextContent(item["content"]);
    if (parts === undefined) {
      return undefined;
    }
    hasUserMessage ||= item["role"] === "user";
    messages.push(deepFreeze({ content: parts, role: item["role"] }));
  }
  if (!hasUserMessage || messages.at(-1)?.role !== "user") {
    return undefined;
  }
  return deepFreeze(messages);
}

function parseTextContent(
  value: JsonValue | undefined,
): readonly ResponsesV2InputTextPart[] | undefined {
  if (typeof value === "string") {
    return isBoundedUnicodeText(value, MAX_RESPONSES_V2_INPUT_BYTES)
      ? deepFreeze([{ text: value, type: "input_text" as const }])
      : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const parts: ResponsesV2InputTextPart[] = [];
  for (const part of value) {
    if (
      !isJsonObject(part) ||
      !hasOnlyKeys(part, INPUT_TEXT_KEYS) ||
      part["type"] !== "input_text" ||
      !isBoundedUnicodeText(part["text"], MAX_RESPONSES_V2_INPUT_BYTES)
    ) {
      return undefined;
    }
    parts.push(Object.freeze({ text: part["text"], type: "input_text" }));
  }
  return deepFreeze(parts);
}

function parseReasoningEffort(value: JsonValue | undefined): string | undefined {
  if (!isJsonObject(value) || !hasOnlyKeys(value, REASONING_KEYS)) {
    return undefined;
  }
  return isBoundedOpaqueText(value["effort"], MAX_REASONING_EFFORT_CHARACTERS)
    ? value["effort"]
    : undefined;
}

function parseFunctionTools(value: unknown): ResponsesV2FunctionTool[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RESPONSES_V2_TOOL_ENTRIES) {
    return undefined;
  }
  const tools: ResponsesV2FunctionTool[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isJsonObject(item) || !hasOnlyKeys(item, FUNCTION_TOOL_KEYS)) {
      return undefined;
    }
    if (
      item["type"] !== "function" ||
      item["strict"] !== true ||
      !isNonEmptyBoundedUnicodeText(item["description"], MAX_TOOL_DESCRIPTION_BYTES) ||
      typeof item["name"] !== "string" ||
      item["name"].length > MAX_TOOL_NAME_CHARACTERS ||
      !toolNamePattern.test(item["name"]) ||
      names.has(item["name"]) ||
      !isJsonObject(item["parameters"])
    ) {
      return undefined;
    }
    names.add(item["name"]);
    tools.push(
      deepFreeze({
        description: item["description"],
        name: item["name"],
        parameters: item["parameters"],
        strict: true as const,
        type: "function" as const,
      }),
    );
  }
  return tools;
}

function hasClosedToolSchema(tool: ResponsesV2FunctionTool): boolean {
  return isCertifiedToolParametersSchema(tool.parameters);
}

function parseCommittedCall(
  value: unknown,
  tools: readonly ResponsesV2FunctionTool[],
): ResponsesV2CommittedToolCall | undefined {
  try {
    const canonicalValue = cloneCanonicalJson(value);
    if (
      !isJsonObject(canonicalValue) ||
      !hasOnlyKeys(canonicalValue, COMMITTED_CALL_KEYS) ||
      canonicalValue["kind"] !== "tool_call" ||
      typeof canonicalValue["itemId"] !== "string" ||
      !itemIdPattern.test(canonicalValue["itemId"]) ||
      typeof canonicalValue["callId"] !== "string" ||
      !callIdPattern.test(canonicalValue["callId"]) ||
      typeof canonicalValue["callRef"] !== "string" ||
      !callReferencePattern.test(canonicalValue["callRef"]) ||
      typeof canonicalValue["tool"] !== "string" ||
      !isJsonObject(canonicalValue["arguments"]) ||
      typeof canonicalValue["argumentsJson"] !== "string"
    ) {
      return undefined;
    }
    const argumentsJson = canonicalizeToolWorkflowJson(canonicalValue["arguments"]);
    const tool = tools.find((candidate) => candidate.name === canonicalValue["tool"]);
    if (
      tool === undefined ||
      argumentsJson !== canonicalValue["argumentsJson"] ||
      encodedBytes(argumentsJson) > MAX_TOOL_WORKFLOW_ARGUMENT_BYTES ||
      !matchesCertifiedToolArguments(tool.parameters, canonicalValue["arguments"])
    ) {
      return undefined;
    }
    return deepFreeze({
      arguments: canonicalValue["arguments"],
      argumentsJson,
      callId: canonicalValue["callId"],
      callRef: canonicalValue["callRef"],
      itemId: canonicalValue["itemId"],
      kind: "tool_call" as const,
      tool: canonicalValue["tool"],
    });
  } catch {
    return undefined;
  }
}

function parseFinalOutcome(value: unknown): Readonly<{ kind: "final"; text: string }> | undefined {
  try {
    const canonicalValue = cloneCanonicalJson(value);
    if (
      !isJsonObject(canonicalValue) ||
      !hasOnlyKeys(canonicalValue, FINAL_OUTCOME_KEYS) ||
      canonicalValue["kind"] !== "final" ||
      !isBoundedUnicodeText(canonicalValue["text"], MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES)
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "final", text: canonicalValue["text"] });
  } catch {
    return undefined;
  }
}

function createFunctionCallItem(value: ResponsesV2CommittedToolCall): ResponsesV2FunctionCallItem {
  return deepFreeze({
    arguments: value.argumentsJson,
    call_id: value.callId,
    id: value.itemId,
    name: value.tool,
    status: "completed" as const,
    type: "function_call" as const,
  });
}

function parseFunctionCallItem(
  value: JsonValue | undefined,
): ResponsesV2FunctionCallItem | undefined {
  if (!isJsonObject(value) || !hasOnlyKeys(value, FUNCTION_CALL_KEYS)) {
    return undefined;
  }
  if (
    value["type"] !== "function_call" ||
    value["status"] !== "completed" ||
    typeof value["arguments"] !== "string" ||
    typeof value["call_id"] !== "string" ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string"
  ) {
    return undefined;
  }
  return deepFreeze({
    arguments: value["arguments"],
    call_id: value["call_id"],
    id: value["id"],
    name: value["name"],
    status: "completed" as const,
    type: "function_call" as const,
  });
}

function parseFunctionCallOutputItem(
  value: JsonValue | undefined,
): ResponsesV2FunctionCallOutputItem | undefined {
  if (!isJsonObject(value) || !hasOnlyKeys(value, FUNCTION_OUTPUT_KEYS)) {
    return undefined;
  }
  if (
    value["type"] !== "function_call_output" ||
    typeof value["call_id"] !== "string" ||
    typeof value["output"] !== "string"
  ) {
    return undefined;
  }
  return deepFreeze({
    call_id: value["call_id"],
    output: value["output"],
    type: "function_call_output" as const,
  });
}

function replaceInput(value: JsonObject, input: readonly JsonValue[]): JsonObject {
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = key === "input" ? [...input] : item;
  }
  return result;
}

function parseStrictJsonObject(source: string, maxBytes: number): JsonObject | undefined {
  if (typeof source !== "string" || encodedBytes(source) > maxBytes || source.length === 0) {
    return undefined;
  }
  try {
    new StrictJsonScanner(source).inspect();
    const parsed = JSON.parse(source) as unknown;
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    canonicalizeToolWorkflowJson(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

class StrictJsonScanner {
  readonly #source: string;
  #index = 0;
  #nodes = 0;

  public constructor(source: string) {
    this.#source = source;
  }

  public inspect(): void {
    this.#skipWhitespace();
    this.#value(1);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      this.#invalid();
    }
  }

  #value(depth: number): void {
    if (depth > MAX_TOOL_WORKFLOW_JSON_DEPTH) {
      this.#invalid();
    }
    this.#nodes += 1;
    if (this.#nodes > MAX_TOOL_WORKFLOW_JSON_NODES) {
      this.#invalid();
    }
    const character = this.#source[this.#index];
    if (character === "{") {
      this.#object(depth);
    } else if (character === "[") {
      this.#array(depth);
    } else if (character === '"') {
      this.#string();
    } else if (character === "t") {
      this.#literal("true");
    } else if (character === "f") {
      this.#literal("false");
    } else if (character === "n") {
      this.#literal("null");
    } else if (character === "-" || isDigit(character)) {
      this.#number();
    } else {
      this.#invalid();
    }
  }

  #object(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#take("}")) {
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      if (this.#source[this.#index] !== '"') {
        this.#invalid();
      }
      const key = this.#string();
      if (keys.has(key) || unsafeJsonKeys.has(key)) {
        this.#invalid();
      }
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      this.#value(depth + 1);
      this.#skipWhitespace();
      if (this.#take("}")) {
        return;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #array(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#take("]")) {
      return;
    }
    for (;;) {
      this.#value(depth + 1);
      this.#skipWhitespace();
      if (this.#take("]")) {
        return;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#expect('"');
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      this.#index += 1;
      if (character === '"') {
        const raw = this.#source.slice(start, this.#index);
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "string" || hasLoneSurrogate(parsed)) {
          this.#invalid();
        }
        return parsed;
      }
      if (character === "\\") {
        const escaped = this.#source[this.#index];
        this.#index += 1;
        if (escaped === "u") {
          for (let offset = 0; offset < 4; offset += 1) {
            const hexadecimal = this.#source[this.#index];
            this.#index += 1;
            if (hexadecimal === undefined || !/[0-9A-Fa-f]/u.test(hexadecimal)) {
              this.#invalid();
            }
          }
        } else if (
          escaped === undefined ||
          !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escaped)
        ) {
          this.#invalid();
        }
      } else if (character === undefined || character.charCodeAt(0) <= 0x1f) {
        this.#invalid();
      }
    }
    this.#invalid();
  }

  #number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.#source.slice(this.#index),
    );
    if (match === null) {
      this.#invalid();
    }
    const raw = match[0];
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      JSON.stringify(value) !== raw
    ) {
      this.#invalid();
    }
    this.#index += raw.length;
  }

  #literal(value: "false" | "null" | "true"): void {
    if (!this.#source.startsWith(value, this.#index)) {
      this.#invalid();
    }
    this.#index += value.length;
  }

  #skipWhitespace(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.#source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  #expect(character: string): void {
    if (!this.#take(character)) {
      this.#invalid();
    }
  }

  #take(character: string): boolean {
    if (this.#source[this.#index] !== character) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #invalid(): never {
    throw new SyntaxError("Invalid Responses v2 JSON.");
  }
}

function digestCanonical(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function cloneCanonicalJson(value: unknown): JsonValue {
  const canonical = canonicalizeToolWorkflowJson(value as JsonValue);
  return JSON.parse(canonical) as JsonValue;
}

function encodedCanonicalBytes(value: JsonValue): number {
  return encodedBytes(canonicalizeToolWorkflowJson(value));
}

function encodedBytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isBoundedUnicodeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && !hasLoneSurrogate(value) && encodedBytes(value) <= maxBytes;
}

function isNonEmptyBoundedUnicodeText(value: unknown, maxBytes: number): value is string {
  return isBoundedUnicodeText(value, maxBytes) && value.length > 0;
}

function isBoundedOpaqueText(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCharacters &&
    opaqueTextPattern.test(value)
  );
}

function hasOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function readOptionalObject(value: JsonObject, key: string): JsonObject | undefined {
  const item = value[key];
  return isJsonObject(item) ? item : undefined;
}

function readOptionalString(value: JsonObject, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function sameOptionalJsonObject(
  left: JsonObject | undefined,
  right: JsonObject | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalizeToolWorkflowJson(left) === canonicalizeToolWorkflowJson(right);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function boundarySuccess<Value>(value: Value): ResponsesV2BoundaryResult<Value> {
  return Object.freeze({ ok: true, value });
}

function boundaryFailure<Value>(
  code: ResponsesV2BoundaryErrorCode,
): ResponsesV2BoundaryResult<Value> {
  const continuation = code === "child_continuation_mismatch";
  return Object.freeze({
    error: Object.freeze({
      code,
      message: continuation
        ? "The Web Agent continuation is unavailable."
        : "The Web Agent request is unavailable.",
    }),
    ok: false,
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

const defaultIdentitySource: ResponsesV2IdentitySource = Object.freeze({
  createMessageId: (): string => `msg_${randomBytes(ID_ENTROPY_BYTES).toString("base64url")}`,
  createResponseId: (): string => `resp_${randomBytes(ID_ENTROPY_BYTES).toString("base64url")}`,
  nowEpochSeconds: (): number => Math.floor(Date.now() / 1_000),
});
