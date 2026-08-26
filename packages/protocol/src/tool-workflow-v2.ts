import { z } from "zod";

import type { JsonObject, JsonValue } from "./json.js";

export const TOOL_WORKFLOW_PROTOCOL_VERSION = 2 as const;
export const TOOL_WORKFLOW_ENVELOPE_BEGIN = "GSB/2 BEGIN";
export const TOOL_WORKFLOW_ENVELOPE_END = "GSB/2 END";
export const MAX_TOOL_WORKFLOW_ENVELOPE_BYTES = 256 * 1024;
export const MAX_TOOL_WORKFLOW_ARGUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_WORKFLOW_RESULT_BYTES = 128 * 1024;
export const MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES = 192 * 1024;
export const MAX_TOOL_WORKFLOW_JSON_DEPTH = 32;
export const MAX_TOOL_WORKFLOW_JSON_NODES = 4_096;
export const MAX_TOOL_WORKFLOW_TOOL_CALLS = 32;
export const MAX_TOOL_WORKFLOW_ROUNDS = MAX_TOOL_WORKFLOW_TOOL_CALLS + 1;

const textEncoder = new TextEncoder();
const turnAliasSchema = z.string().regex(/^wt_[A-Za-z0-9_-]{16,96}$/u);
const roundChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);
const manifestDigestSchema = z.string().regex(/^sha256-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const toolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const callReferenceSchema = z.string().regex(/^wc_[A-Za-z0-9_-]{16,96}$/u);
const workflowRoundSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOOL_WORKFLOW_ROUNDS - 1);
const toolCallRoundSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOOL_WORKFLOW_TOOL_CALLS - 1);
const toolResultRoundSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TOOL_WORKFLOW_ROUNDS - 1);
const unsafeJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

const assistantEnvelopeBase = {
  v: z.literal(TOOL_WORKFLOW_PROTOCOL_VERSION),
  turn: turnAliasSchema,
  challenge: roundChallengeSchema,
  manifestDigest: manifestDigestSchema,
} as const;

export const toolWorkflowArgumentsSchema = z.custom<JsonObject>(isValidToolWorkflowArguments);

export const toolWorkflowCallEnvelopeSchema = z
  .object({
    ...assistantEnvelopeBase,
    round: toolCallRoundSchema,
    kind: z.literal("tool_call"),
    tool: toolNameSchema,
    arguments: toolWorkflowArgumentsSchema,
  })
  .strict();

export const toolWorkflowFinalEnvelopeSchema = z
  .object({
    ...assistantEnvelopeBase,
    round: workflowRoundSchema,
    kind: z.literal("final"),
    text: z.string(),
  })
  .strict();

export const toolWorkflowAssistantEnvelopeSchema = z.discriminatedUnion("kind", [
  toolWorkflowCallEnvelopeSchema,
  toolWorkflowFinalEnvelopeSchema,
]);

export const toolWorkflowResultEnvelopeSchema = z
  .object({
    v: z.literal(TOOL_WORKFLOW_PROTOCOL_VERSION),
    kind: z.literal("tool_result"),
    turn: turnAliasSchema,
    round: toolResultRoundSchema,
    challenge: roundChallengeSchema,
    manifestDigest: manifestDigestSchema,
    callRef: callReferenceSchema,
    tool: toolNameSchema,
    ok: z.boolean(),
    output: z.string(),
  })
  .strict();

export type ToolWorkflowCallEnvelope = z.infer<typeof toolWorkflowCallEnvelopeSchema>;
export type ToolWorkflowFinalEnvelope = z.infer<typeof toolWorkflowFinalEnvelopeSchema>;
export type ToolWorkflowAssistantEnvelope = z.infer<typeof toolWorkflowAssistantEnvelopeSchema>;
export type ToolWorkflowResultEnvelope = z.infer<typeof toolWorkflowResultEnvelopeSchema>;

export const TOOL_WORKFLOW_PARSE_ERROR_CODES = [
  "protocol_envelope_invalid",
  "protocol_envelope_too_large",
  "protocol_json_duplicate_key",
  "protocol_json_number_invalid",
  "protocol_json_string_invalid",
  "protocol_json_unsafe_key",
  "protocol_json_too_deep",
  "protocol_json_too_complex",
  "protocol_arguments_too_large",
  "protocol_final_text_too_large",
] as const;

export type ToolWorkflowParseErrorCode = (typeof TOOL_WORKFLOW_PARSE_ERROR_CODES)[number];

export type ToolWorkflowParseResult =
  | Readonly<{ ok: true; envelope: ToolWorkflowAssistantEnvelope }>
  | Readonly<{ ok: false; code: ToolWorkflowParseErrorCode }>;

/**
 * Parses one complete assistant response. This codec deliberately accepts no
 * prose, Markdown fence, byte-order mark, CRLF, or trailing data. A challenge
 * correlates a round but does not authenticate model-generated content.
 */
export function parseToolWorkflowAssistantEnvelope(text: string): ToolWorkflowParseResult {
  if (textEncoder.encode(text).byteLength > MAX_TOOL_WORKFLOW_ENVELOPE_BYTES) {
    return failure("protocol_envelope_too_large");
  }

  const prefix = `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n`;
  const suffix = `\n${TOOL_WORKFLOW_ENVELOPE_END}`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    return failure("protocol_envelope_invalid");
  }

  const body = text.slice(prefix.length, -suffix.length);
  if (
    body.length === 0 ||
    !body.startsWith("{") ||
    body.at(-1) !== "}" ||
    body.includes("\n") ||
    body.includes("\r") ||
    body.includes("\uFEFF")
  ) {
    return failure("protocol_envelope_invalid");
  }

  const structuralError = inspectJsonStructure(body);
  if (structuralError !== undefined) {
    return failure(structuralError);
  }

  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return failure("protocol_envelope_invalid");
  }

  const parsed = toolWorkflowAssistantEnvelopeSchema.safeParse(value);
  if (!parsed.success || !sameJsonValue(value, parsed.data)) {
    return failure("protocol_envelope_invalid");
  }

  if (parsed.data.kind === "tool_call") {
    if (encodedCanonicalJsonBytes(parsed.data.arguments) > MAX_TOOL_WORKFLOW_ARGUMENT_BYTES) {
      return failure("protocol_arguments_too_large");
    }
  } else if (textEncoder.encode(parsed.data.text).byteLength > MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES) {
    return failure("protocol_final_text_too_large");
  }

  return Object.freeze({ ok: true, envelope: deepFreezeJson(parsed.data) });
}

/**
 * Serializes bridge-owned data for the visible composer. Callers must still
 * bind the envelope to the selected document and current workflow state.
 */
export function serializeToolWorkflowResultEnvelope(envelope: ToolWorkflowResultEnvelope): string {
  const parsed = toolWorkflowResultEnvelopeSchema.parse(envelope);
  if (textEncoder.encode(parsed.output).byteLength > MAX_TOOL_WORKFLOW_RESULT_BYTES) {
    throw new RangeError("Tool workflow result exceeds the protocol byte limit.");
  }

  const canonical = canonicalizeToolWorkflowJson(parsed);
  const serialized = `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n${canonical}\n${TOOL_WORKFLOW_ENVELOPE_END}`;
  if (textEncoder.encode(serialized).byteLength > MAX_TOOL_WORKFLOW_ENVELOPE_BYTES) {
    throw new RangeError("Tool workflow envelope exceeds the protocol byte limit.");
  }
  return serialized;
}

/**
 * Implements the RFC 8785 JSON Canonicalization Scheme for the protocol's
 * restricted I-JSON domain. Integers outside Number's safe range, lone UTF-16
 * surrogates, prototype-sensitive keys, exotic objects, and excess structure
 * fail rather than being rounded, normalized, invoked, or silently omitted.
 */
export function canonicalizeToolWorkflowJson(value: JsonValue): string {
  return canonicalizeJsonValue(value, 1, { nodes: 0 });
}

function canonicalizeJsonValue(value: unknown, depth: number, state: { nodes: number }): string {
  if (depth > MAX_TOOL_WORKFLOW_JSON_DEPTH) {
    throw new RangeError("Tool workflow JSON exceeds the depth limit.");
  }
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_WORKFLOW_JSON_NODES) {
    throw new RangeError("Tool workflow JSON exceeds the node limit.");
  }

  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalizeNumber(value);
    case "string":
      return canonicalizeString(value);
    case "object":
      return Array.isArray(value)
        ? canonicalizeArray(value, depth, state)
        : canonicalizeObject(value, depth, state);
    default:
      throw new TypeError("Tool workflow value is not JSON-compatible.");
  }
}

function canonicalizeArray(
  value: readonly unknown[],
  depth: number,
  state: { nodes: number },
): string {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError("Tool workflow arrays must be dense JSON arrays.");
  }

  const serialized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Tool workflow arrays must contain only data elements.");
    }
    serialized.push(canonicalizeJsonValue(descriptor.value, depth + 1, state));
  }
  return `[${serialized.join(",")}]`;
}

function canonicalizeObject(value: object, depth: number, state: { nodes: number }): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Tool workflow objects must be plain JSON objects.");
  }

  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")) {
    throw new TypeError("Tool workflow objects must contain only string keys.");
  }
  keys.sort(compareUtf16);

  const serialized: string[] = [];
  for (const key of keys) {
    if (unsafeJsonKeys.has(key)) {
      throw new TypeError("Tool workflow object contains a reserved key.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      hasLoneSurrogate(key)
    ) {
      throw new TypeError("Tool workflow object is not a plain JSON record.");
    }
    serialized.push(
      `${canonicalizeString(key)}:${canonicalizeJsonValue(descriptor.value, depth + 1, state)}`,
    );
  }
  return `{${serialized.join(",")}}`;
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new RangeError("Tool workflow number is outside the supported numeric domain.");
  }
  return JSON.stringify(value);
}

function canonicalizeString(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("Tool workflow string is not valid Unicode.");
  }
  return JSON.stringify(value);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isValidToolWorkflowArguments(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) {
    return false;
  }
  try {
    canonicalizeToolWorkflowJson(value);
    return true;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function encodedCanonicalJsonBytes(value: JsonValue): number {
  return textEncoder.encode(canonicalizeToolWorkflowJson(value)).byteLength;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}

function deepFreezeJson<Value extends ToolWorkflowAssistantEnvelope>(value: Value): Value {
  if (value.kind === "tool_call") {
    deepFreezeJsonValue(value.arguments);
  }
  return Object.freeze(value);
}

function deepFreezeJsonValue(value: JsonValue): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJsonValue(item);
    }
  } else {
    for (const item of Object.values(value)) {
      deepFreezeJsonValue(item);
    }
  }
  Object.freeze(value);
}

function failure(code: ToolWorkflowParseErrorCode): ToolWorkflowParseResult {
  return Object.freeze({ ok: false, code });
}

type StructuralError = Extract<
  ToolWorkflowParseErrorCode,
  | "protocol_envelope_invalid"
  | "protocol_json_duplicate_key"
  | "protocol_json_number_invalid"
  | "protocol_json_string_invalid"
  | "protocol_json_unsafe_key"
  | "protocol_json_too_deep"
  | "protocol_json_too_complex"
>;

function inspectJsonStructure(source: string): StructuralError | undefined {
  try {
    const scanner = new JsonStructureScanner(source);
    scanner.inspect();
    return undefined;
  } catch (error) {
    return error instanceof JsonStructureError ? error.code : "protocol_envelope_invalid";
  }
}

class JsonStructureError extends Error {
  readonly code: StructuralError;

  constructor(code: StructuralError) {
    super(code);
    this.code = code;
  }
}

class JsonStructureScanner {
  readonly #source: string;
  #index = 0;
  #nodes = 0;

  constructor(source: string) {
    this.#source = source;
  }

  inspect(): void {
    this.#skipWhitespace();
    this.#value(1);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      this.#invalid();
    }
  }

  #value(depth: number): void {
    if (depth > MAX_TOOL_WORKFLOW_JSON_DEPTH) {
      throw new JsonStructureError("protocol_json_too_deep");
    }
    this.#nodes += 1;
    if (this.#nodes > MAX_TOOL_WORKFLOW_JSON_NODES) {
      throw new JsonStructureError("protocol_json_too_complex");
    }

    const character = this.#source[this.#index];
    switch (character) {
      case "{":
        this.#object(depth);
        return;
      case "[":
        this.#array(depth);
        return;
      case '"':
        this.#string();
        return;
      case "t":
        this.#literal("true");
        return;
      case "f":
        this.#literal("false");
        return;
      case "n":
        this.#literal("null");
        return;
      default:
        if (character === "-" || isDigit(character)) {
          this.#number();
          return;
        }
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
      if (keys.has(key)) {
        throw new JsonStructureError("protocol_json_duplicate_key");
      }
      if (unsafeJsonKeys.has(key)) {
        throw new JsonStructureError("protocol_json_unsafe_key");
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
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "string") {
            this.#invalid();
          }
          if (hasLoneSurrogate(parsed)) {
            throw new JsonStructureError("protocol_json_string_invalid");
          }
          return parsed;
        } catch (error) {
          if (error instanceof JsonStructureError) {
            throw error;
          }
          this.#invalid();
        }
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
    const remainder = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remainder);
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
      throw new JsonStructureError("protocol_json_number_invalid");
    }
    this.#index += raw.length;
  }

  #literal(literal: "true" | "false" | "null"): void {
    if (!this.#source.startsWith(literal, this.#index)) {
      this.#invalid();
    }
    this.#index += literal.length;
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
    throw new JsonStructureError("protocol_envelope_invalid");
  }
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
