import { createHash } from "node:crypto";

import {
  MAX_TOOL_WORKFLOW_ARGUMENT_BYTES,
  MAX_TOOL_WORKFLOW_RESULT_BYTES,
  MAX_TOOL_WORKFLOW_TOOL_CALLS,
  canonicalizeToolWorkflowJson,
  modelIdSchema,
  reasoningEffortSchema,
  type JsonObject,
  type JsonValue,
} from "@gpt-session-bridge/protocol";

import {
  isCertifiedToolParametersSchema,
  matchesCertifiedToolArguments,
} from "../tooling/certified-tool-schema.js";
import {
  MAX_RESPONSES_V2_INPUT_BYTES,
  MAX_RESPONSES_V2_INPUT_ITEMS,
  MAX_RESPONSES_V2_INSTRUCTIONS_BYTES,
  MAX_RESPONSES_V2_MANIFEST_BYTES,
  MAX_RESPONSES_V2_REQUEST_BYTES,
  MAX_RESPONSES_V2_TOOL_ENTRIES,
  type ResponsesV2CertifiedToolProfile,
  type ResponsesV2FunctionTool,
} from "./responses-server-v2.js";

const CONTRACT_VERSION = "codex-responses-v2-v1";
const EXEC_COMMAND_TOOL = "exec_command";
const MAX_TOOL_DESCRIPTION_BYTES = 4 * 1024;
const MAX_TOOL_NAME_CHARACTERS = 64;
const MAX_CODEX_TOOL_ENTRIES = 128;
const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/u;
const functionCallIdPattern = /^call_[A-Za-z0-9_-]{16,128}$/u;
const functionItemIdPattern = /^fc_[A-Za-z0-9_-]{16,128}$/u;
const textEncoder = new TextEncoder();
const EMPTY_CONTINUATION_HISTORY_FINGERPRINT = digestCanonical("[]");

export const CODEX_RESPONSES_V2_CONTRACT_ERROR_CODES = [
  "codex_request_invalid",
  "codex_tool_profile_unsupported",
  "codex_contract_drift",
  "codex_tool_arguments_invalid",
] as const;

export type CodexResponsesV2ContractErrorCode =
  (typeof CODEX_RESPONSES_V2_CONTRACT_ERROR_CODES)[number];

export interface CodexResponsesV2ContractError {
  readonly code: CodexResponsesV2ContractErrorCode;
  readonly message: string;
}

export type CodexResponsesV2ContractResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: CodexResponsesV2ContractError; ok: false }>;

export interface CodexResponsesV2ContractBinding {
  readonly fingerprint: string;
  readonly historyFingerprint: string;
}

export interface CodexResponsesV2ProjectionOptions {
  readonly defaultReasoningEffort?: string;
}

export interface CodexResponsesV2InitialProjection extends CodexResponsesV2ContractBinding {
  readonly canonicalBody: string;
  readonly kind: "initial";
  readonly profile: ResponsesV2CertifiedToolProfile;
}

export interface CodexResponsesV2ContinuationProjection extends CodexResponsesV2ContractBinding {
  readonly canonicalBody: string;
  readonly kind: "continuation";
  readonly profile: ResponsesV2CertifiedToolProfile;
}

interface ProjectedToolContract {
  readonly fingerprint: string;
  readonly profile: ResponsesV2CertifiedToolProfile;
}

interface ProjectedRequestFields {
  readonly instructions?: string;
  readonly model: string;
  readonly reasoning: Readonly<{ effort: string }>;
  readonly store: false;
  readonly stream: boolean;
  readonly toolChoice: "auto";
}

interface ProjectedContinuationInput {
  readonly historyFingerprint: string;
  readonly input: readonly JsonValue[];
}

/**
 * Projects the broader request emitted by Codex into the exact initial subset
 * admitted by ResponsesServerV2. The input is an already-decoded JSON value;
 * exotic objects, accessors, unsafe numbers, and reserved keys fail closed.
 */
export function projectCodexResponsesV2Initial(
  body: unknown,
  options: CodexResponsesV2ProjectionOptions = {},
): CodexResponsesV2ContractResult<CodexResponsesV2InitialProjection> {
  const source = readDataObject(body);
  if (source === undefined) {
    return contractFailure("codex_request_invalid");
  }
  const tools = projectToolContract(source["tools"]);
  if (!tools.ok) {
    return tools;
  }
  const fields = projectRequestFields(source, options.defaultReasoningEffort);
  const input = projectInitialInput(source["input"]);
  if (fields === undefined || input === undefined) {
    return contractFailure("codex_request_invalid");
  }
  return createProjection(
    "initial",
    fields,
    input,
    tools.value,
    EMPTY_CONTINUATION_HISTORY_FINGERPRINT,
  );
}

/**
 * Projects one real Codex continuation and binds it to the effective function
 * profile selected for the initial request. Function arguments are validated
 * locally before the canonical body reaches ResponsesServerV2.
 */
export function projectCodexResponsesV2Continuation(
  body: unknown,
  binding: CodexResponsesV2ContractBinding,
  options: CodexResponsesV2ProjectionOptions = {},
): CodexResponsesV2ContractResult<CodexResponsesV2ContinuationProjection> {
  if (!isContractBinding(binding)) {
    return contractFailure("codex_contract_drift");
  }
  const source = readDataObject(body);
  if (source === undefined) {
    return contractFailure("codex_request_invalid");
  }
  const tools = projectToolContract(source["tools"]);
  if (!tools.ok) {
    return tools;
  }
  if (tools.value.fingerprint !== binding.fingerprint) {
    return contractFailure("codex_contract_drift");
  }
  const fields = projectRequestFields(source, options.defaultReasoningEffort);
  if (fields === undefined) {
    return contractFailure("codex_request_invalid");
  }
  const input = projectContinuationInput(
    source["input"],
    tools.value.profile.tools,
    binding.historyFingerprint,
  );
  if (!input.ok) {
    return input;
  }
  return createProjection(
    "continuation",
    fields,
    input.value.input,
    tools.value,
    input.value.historyFingerprint,
  );
}

function createProjection(
  kind: "initial",
  fields: ProjectedRequestFields,
  input: readonly JsonValue[],
  tools: ProjectedToolContract,
  historyFingerprint: string,
): CodexResponsesV2ContractResult<CodexResponsesV2InitialProjection>;
function createProjection(
  kind: "continuation",
  fields: ProjectedRequestFields,
  input: readonly JsonValue[],
  tools: ProjectedToolContract,
  historyFingerprint: string,
): CodexResponsesV2ContractResult<CodexResponsesV2ContinuationProjection>;
function createProjection(
  kind: "continuation" | "initial",
  fields: ProjectedRequestFields,
  input: readonly JsonValue[],
  tools: ProjectedToolContract,
  historyFingerprint: string,
): CodexResponsesV2ContractResult<
  CodexResponsesV2ContinuationProjection | CodexResponsesV2InitialProjection
> {
  const projected: JsonObject = {
    include: [],
    input: [...input],
    ...(fields.instructions === undefined ? {} : { instructions: fields.instructions }),
    model: fields.model,
    parallel_tool_calls: false,
    reasoning: { effort: fields.reasoning.effort },
    store: fields.store,
    stream: fields.stream,
    tool_choice: fields.toolChoice,
    tools: tools.profile.tools as unknown as JsonValue,
  };
  let canonicalBody: string;
  try {
    canonicalBody = canonicalizeToolWorkflowJson(projected);
  } catch {
    return contractFailure("codex_request_invalid");
  }
  if (encodedBytes(canonicalBody) > MAX_RESPONSES_V2_REQUEST_BYTES) {
    return contractFailure("codex_request_invalid");
  }
  return contractSuccess(
    Object.freeze({
      canonicalBody,
      fingerprint: tools.fingerprint,
      historyFingerprint,
      kind,
      profile: tools.profile,
    }),
  );
}

function projectRequestFields(
  source: JsonObject,
  defaultReasoningEffort: string | undefined,
): ProjectedRequestFields | undefined {
  const instructions = source["instructions"];
  const model = source["model"];
  const reasoning = source["reasoning"];
  const stream = source["stream"];
  const reasoningEffort = isDataRecord(reasoning)
    ? (reasoning["effort"] ?? defaultReasoningEffort)
    : undefined;
  if (
    (instructions !== undefined &&
      (typeof instructions !== "string" ||
        encodedBytes(instructions) > MAX_RESPONSES_V2_INSTRUCTIONS_BYTES)) ||
    !modelIdSchema.safeParse(model).success ||
    !isDataRecord(reasoning) ||
    !reasoningEffortSchema.safeParse(reasoningEffort).success ||
    source["store"] !== false ||
    typeof stream !== "boolean" ||
    source["tool_choice"] !== "auto"
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(instructions === undefined ? {} : { instructions }),
    model: model as string,
    reasoning: Object.freeze({ effort: reasoningEffort as string }),
    store: false as const,
    stream,
    toolChoice: "auto" as const,
  });
}

function projectInitialInput(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RESPONSES_V2_INPUT_ITEMS) {
    return undefined;
  }
  const messages = projectMessagePrefix(value);
  if (
    messages === undefined ||
    encodedCanonicalBytes([...messages]) > MAX_RESPONSES_V2_INPUT_BYTES
  ) {
    return undefined;
  }
  return messages;
}

function projectContinuationInput(
  value: JsonValue | undefined,
  tools: readonly ResponsesV2FunctionTool[],
  expectedHistoryFingerprint: string,
): CodexResponsesV2ContractResult<ProjectedContinuationInput> {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > MAX_RESPONSES_V2_INPUT_ITEMS + MAX_TOOL_WORKFLOW_TOOL_CALLS * 2 ||
    !isDenseDataArray(value)
  ) {
    return contractFailure("codex_request_invalid");
  }
  let messageCount = 0;
  while (
    messageCount < value.length &&
    projectMessage(value[messageCount] as JsonValue) !== undefined
  ) {
    messageCount += 1;
  }
  const messages = projectMessagePrefix(value.slice(0, messageCount));
  const suffix = value.slice(messageCount);
  if (
    messages === undefined ||
    suffix.length < 2 ||
    suffix.length % 2 !== 0 ||
    suffix.length > MAX_TOOL_WORKFLOW_TOOL_CALLS * 2 ||
    encodedCanonicalBytes([...messages]) > MAX_RESPONSES_V2_INPUT_BYTES
  ) {
    return contractFailure("codex_request_invalid");
  }
  const projectedHistory: JsonValue[] = [];
  for (let index = 0; index < suffix.length; index += 2) {
    const call = projectFunctionCall(suffix[index], tools);
    if (!call.ok) {
      return call;
    }
    const output = projectFunctionCallOutput(suffix[index + 1]);
    if (
      output === undefined ||
      output.call_id !== call.value["call_id"] ||
      encodedBytes(output.output) > MAX_TOOL_WORKFLOW_RESULT_BYTES
    ) {
      return contractFailure("codex_request_invalid");
    }
    projectedHistory.push(call.value, output);
  }
  let priorHistory: string;
  let fullHistory: string;
  try {
    priorHistory = canonicalizeToolWorkflowJson(projectedHistory.slice(0, -2));
    fullHistory = canonicalizeToolWorkflowJson(projectedHistory);
  } catch {
    return contractFailure("codex_request_invalid");
  }
  if (
    encodedBytes(fullHistory) > MAX_RESPONSES_V2_REQUEST_BYTES ||
    digestCanonical(priorHistory) !== expectedHistoryFingerprint
  ) {
    return contractFailure("codex_contract_drift");
  }
  const latest = projectedHistory.slice(-2);
  return contractSuccess(
    deepFreeze({
      historyFingerprint: digestCanonical(fullHistory),
      input: [...messages, ...latest],
    }),
  );
}

function projectMessagePrefix(value: readonly JsonValue[]): readonly JsonValue[] | undefined {
  if (value.length === 0 || value.length > MAX_RESPONSES_V2_INPUT_ITEMS) {
    return undefined;
  }
  const messages: JsonObject[] = [];
  let hasUser = false;
  for (const item of value) {
    const projected = projectMessage(item);
    if (projected === undefined) {
      return undefined;
    }
    hasUser ||= projected["role"] === "user";
    messages.push(projected);
  }
  if (!hasUser || messages.at(-1)?.["role"] !== "user") {
    return undefined;
  }
  return deepFreeze(messages);
}

function projectMessage(value: JsonValue): JsonObject | undefined {
  if (!isDataRecord(value)) {
    return undefined;
  }
  const role = value["role"];
  const type = value["type"];
  if ((role !== "developer" && role !== "user") || (type !== undefined && type !== "message")) {
    return undefined;
  }
  const content = projectMessageContent(value["content"]);
  if (content === undefined) {
    return undefined;
  }
  return deepFreeze({
    content,
    role,
    ...(type === undefined ? {} : { type: "message" }),
  });
}

function projectMessageContent(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const parts: JsonObject[] = [];
  for (const part of value) {
    if (!isDataRecord(part) || part["type"] !== "input_text" || typeof part["text"] !== "string") {
      return undefined;
    }
    parts.push(Object.freeze({ text: part["text"], type: "input_text" }));
  }
  return deepFreeze(parts);
}

function projectToolContract(
  value: JsonValue | undefined,
): CodexResponsesV2ContractResult<ProjectedToolContract> {
  if (!Array.isArray(value)) {
    return contractFailure("codex_tool_profile_unsupported");
  }
  if (value.length > MAX_CODEX_TOOL_ENTRIES || !isDenseDataArray(value)) {
    return contractFailure("codex_tool_profile_unsupported");
  }
  const tools: ResponsesV2FunctionTool[] = [];
  const names = new Set<string>();
  for (const candidate of value) {
    if (!isDataRecord(candidate) || candidate["type"] !== "function") {
      continue;
    }
    const description = candidate["description"];
    const name = candidate["name"];
    const parameters = candidate["parameters"];
    const strict = candidate["strict"];
    if (
      typeof description !== "string" ||
      description.length === 0 ||
      encodedBytes(description) > MAX_TOOL_DESCRIPTION_BYTES ||
      typeof name !== "string" ||
      name.length > MAX_TOOL_NAME_CHARACTERS ||
      !toolNamePattern.test(name) ||
      names.has(name) ||
      typeof strict !== "boolean" ||
      !isCertifiedToolParametersSchema(parameters)
    ) {
      return contractFailure("codex_tool_profile_unsupported");
    }
    const clonedParameters = cloneCanonicalObject(parameters);
    if (clonedParameters === undefined) {
      return contractFailure("codex_tool_profile_unsupported");
    }
    names.add(name);
    tools.push(
      deepFreeze({
        description,
        name,
        parameters: clonedParameters,
        strict,
        type: "function" as const,
      }),
    );
  }
  if (
    tools.length === 0 ||
    tools.length > MAX_RESPONSES_V2_TOOL_ENTRIES ||
    !names.has(EXEC_COMMAND_TOOL)
  ) {
    return contractFailure("codex_tool_profile_unsupported");
  }

  const canonicalTools = canonicalizeToolWorkflowJson(tools as unknown as JsonValue);
  const fingerprint = digestCanonical(
    canonicalizeToolWorkflowJson({
      contractVersion: CONTRACT_VERSION,
      tools: tools as unknown as JsonValue,
    }),
  );
  const profileVersion = `codex-dynamic-v1-${fingerprint.slice("sha256-".length, 39)}`;
  const manifest = canonicalizeToolWorkflowJson({
    parallelToolCalls: false,
    profileVersion,
    tools: tools as unknown as JsonValue,
  });
  if (
    encodedBytes(canonicalTools) > MAX_RESPONSES_V2_MANIFEST_BYTES ||
    encodedBytes(manifest) > MAX_RESPONSES_V2_MANIFEST_BYTES
  ) {
    return contractFailure("codex_tool_profile_unsupported");
  }
  const profile: ResponsesV2CertifiedToolProfile = deepFreeze({
    manifestDigest: digestCanonical(manifest),
    parallelToolCalls: false,
    profileVersion,
    tools,
  });
  return contractSuccess(Object.freeze({ fingerprint, profile }));
}

function projectFunctionCall(
  value: JsonValue | undefined,
  tools: readonly ResponsesV2FunctionTool[],
): CodexResponsesV2ContractResult<JsonObject> {
  if (!isDataRecord(value)) {
    return contractFailure("codex_request_invalid");
  }
  const argumentsJson = value["arguments"];
  const callId = value["call_id"];
  const itemId = value["id"];
  const name = value["name"];
  const status = value["status"];
  if (
    value["type"] !== "function_call" ||
    typeof argumentsJson !== "string" ||
    typeof callId !== "string" ||
    !functionCallIdPattern.test(callId) ||
    typeof itemId !== "string" ||
    !functionItemIdPattern.test(itemId) ||
    typeof name !== "string" ||
    (status !== undefined && status !== "completed")
  ) {
    return contractFailure("codex_request_invalid");
  }
  const tool = tools.find((candidate) => candidate.name === name);
  const argumentsValue = parseCanonicalArguments(argumentsJson);
  if (
    tool === undefined ||
    argumentsValue === undefined ||
    !matchesCertifiedToolArguments(tool.parameters, argumentsValue)
  ) {
    return contractFailure("codex_tool_arguments_invalid");
  }
  return contractSuccess(
    deepFreeze({
      arguments: argumentsJson,
      call_id: callId,
      id: itemId,
      name,
      status: "completed",
      type: "function_call",
    }),
  );
}

function projectFunctionCallOutput(value: JsonValue | undefined):
  | Readonly<{
      readonly call_id: string;
      readonly output: string;
      readonly type: "function_call_output";
    }>
  | undefined {
  if (!isDataRecord(value)) {
    return undefined;
  }
  const callId = value["call_id"];
  const output = value["output"];
  const itemId = value["id"];
  if (
    value["type"] !== "function_call_output" ||
    typeof callId !== "string" ||
    !functionCallIdPattern.test(callId) ||
    typeof output !== "string" ||
    (itemId !== undefined && typeof itemId !== "string")
  ) {
    return undefined;
  }
  return Object.freeze({ call_id: callId, output, type: "function_call_output" });
}

function parseCanonicalArguments(value: string): JsonObject | undefined {
  if (encodedBytes(value) > MAX_TOOL_WORKFLOW_ARGUMENT_BYTES) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isDataRecord(parsed)) {
      return undefined;
    }
    return canonicalizeToolWorkflowJson(parsed) === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cloneCanonicalObject(value: unknown): JsonObject | undefined {
  try {
    const canonical = canonicalizeToolWorkflowJson(value as JsonValue);
    const cloned: unknown = JSON.parse(canonical);
    return isDataRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

function readDataObject(value: unknown): JsonObject | undefined {
  return isDataRecord(value) && Reflect.ownKeys(value).length <= 64 ? value : undefined;
}

function encodedCanonicalBytes(value: JsonValue): number {
  try {
    return encodedBytes(canonicalizeToolWorkflowJson(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function encodedBytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function digestCanonical(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function isContractBinding(value: unknown): value is CodexResponsesV2ContractBinding {
  return (
    isDataRecord(value) &&
    typeof value["fingerprint"] === "string" &&
    /^sha256-[A-Za-z0-9_-]{43}$/u.test(value["fingerprint"]) &&
    typeof value["historyFingerprint"] === "string" &&
    /^sha256-[A-Za-z0-9_-]{43}$/u.test(value["historyFingerprint"])
  );
}

function isDataRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function isDenseDataArray(value: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return false;
    }
  }
  return true;
}

function contractSuccess<Value>(value: Value): CodexResponsesV2ContractResult<Value> {
  return Object.freeze({ ok: true, value });
}

function contractFailure<Value>(
  code: CodexResponsesV2ContractErrorCode,
): CodexResponsesV2ContractResult<Value> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message:
        code === "codex_contract_drift"
          ? "The Codex Responses continuation contract changed."
          : "The Codex Responses request is unsupported.",
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
