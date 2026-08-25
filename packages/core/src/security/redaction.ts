import { toDataRecord } from "./internal/validation.js";

const MAX_INSPECTED_FIELDS = 128;
const MAX_INSPECTION_DEPTH = 4;
const MAX_METRIC_VALUE = 2_147_483_647;

const SENSITIVE_KEYS = new Set([
  "account",
  "args",
  "authorization",
  "bearer",
  "body",
  "clipboard",
  "content",
  "conversation",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "cwd",
  "dom",
  "email",
  "filename",
  "filepath",
  "header",
  "headers",
  "history",
  "html",
  "input",
  "output",
  "params",
  "passphrase",
  "password",
  "path",
  "prompt",
  "proxyauthorization",
  "query",
  "requestbody",
  "response",
  "responsebody",
  "result",
  "secret",
  "session",
  "setcookie",
  "token",
  "tokens",
  "username",
]);

const SENSITIVE_SUFFIXES = [
  "authorization",
  "cookie",
  "credential",
  "cwd",
  "email",
  "params",
  "passphrase",
  "password",
  "path",
  "prompt",
  "response",
  "result",
  "secret",
  "token",
] as const;

export const SAFE_ERROR_CODES = [
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_INVALID_ARG_TYPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UNKNOWN",
] as const;

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

const safeErrorCodeSet = new Set<SafeErrorCode>(SAFE_ERROR_CODES);

export interface RedactedErrorMetadata {
  readonly attempt?: number;
  readonly bytes?: number;
  readonly causeCode?: SafeErrorCode;
  readonly code?: SafeErrorCode;
  readonly discardedFields?: number;
  readonly durationMs?: number;
  readonly redactedFields?: number;
  readonly retryable?: boolean;
  readonly status?: number;
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "");

  if (normalized.length === 0) {
    return false;
  }
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }

  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function redactErrorMetadata(value: unknown): RedactedErrorMetadata {
  const output: MutableRedactedErrorMetadata = {};
  const state: InspectionState = {
    discardedFields: 0,
    inspectedFields: 0,
    redactedFields: 0,
    seen: new WeakSet<object>(),
  };

  let record: Readonly<Record<string, unknown>>;
  try {
    record = toDataRecord(value);
  } catch {
    return Object.freeze({ discardedFields: 1 });
  }

  inspectRecord(record, 0, true, output, state);

  if (state.redactedFields > 0) {
    output.redactedFields = state.redactedFields;
  }
  if (state.discardedFields > 0) {
    output.discardedFields = state.discardedFields;
  }

  return Object.freeze(output);
}

interface MutableRedactedErrorMetadata {
  attempt?: number;
  bytes?: number;
  causeCode?: SafeErrorCode;
  code?: SafeErrorCode;
  discardedFields?: number;
  durationMs?: number;
  redactedFields?: number;
  retryable?: boolean;
  status?: number;
}

interface InspectionState {
  discardedFields: number;
  inspectedFields: number;
  redactedFields: number;
  readonly seen: WeakSet<object>;
}

function inspectRecord(
  record: Readonly<Record<string, unknown>>,
  depth: number,
  allowSafeFields: boolean,
  output: MutableRedactedErrorMetadata,
  state: InspectionState,
): void {
  if (state.seen.has(record)) {
    state.discardedFields += 1;
    return;
  }
  state.seen.add(record);

  for (const [key, fieldValue] of Object.entries(record)) {
    if (state.inspectedFields >= MAX_INSPECTED_FIELDS) {
      state.discardedFields += 1;
      return;
    }
    state.inspectedFields += 1;

    if (isSensitiveKey(key)) {
      state.redactedFields += 1;
      continue;
    }

    if (allowSafeFields && assignSafeField(output, key, fieldValue)) {
      continue;
    }

    state.discardedFields += 1;
    if (depth < MAX_INSPECTION_DEPTH) {
      inspectNestedValue(fieldValue, depth + 1, output, state);
    }
  }
}

function inspectNestedValue(
  value: unknown,
  depth: number,
  output: MutableRedactedErrorMetadata,
  state: InspectionState,
): void {
  if (typeof value !== "object" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, MAX_INSPECTED_FIELDS - state.inspectedFields)) {
      inspectNestedValue(entry, depth, output, state);
    }
    return;
  }

  try {
    inspectRecord(toDataRecord(value), depth, false, output, state);
  } catch {
    state.discardedFields += 1;
  }
}

function assignSafeField(
  output: MutableRedactedErrorMetadata,
  key: string,
  value: unknown,
): boolean {
  switch (key) {
    case "attempt": {
      const metric = readMetric(value);
      if (metric !== undefined) {
        output.attempt = metric;
      }
      return metric !== undefined;
    }
    case "bytes": {
      const metric = readMetric(value);
      if (metric !== undefined) {
        output.bytes = metric;
      }
      return metric !== undefined;
    }
    case "causeCode": {
      const code = readSafeErrorCode(value);
      if (code !== undefined) {
        output.causeCode = code;
      }
      return code !== undefined;
    }
    case "code": {
      const code = readSafeErrorCode(value);
      if (code !== undefined) {
        output.code = code;
      }
      return code !== undefined;
    }
    case "durationMs": {
      const metric = readMetric(value);
      if (metric !== undefined) {
        output.durationMs = metric;
      }
      return metric !== undefined;
    }
    case "discardedFields": {
      const metric = readMetric(value);
      if (metric !== undefined) {
        output.discardedFields = metric;
      }
      return metric !== undefined;
    }
    case "redactedFields": {
      const metric = readMetric(value);
      if (metric !== undefined) {
        output.redactedFields = metric;
      }
      return metric !== undefined;
    }
    case "retryable":
      if (typeof value === "boolean") {
        output.retryable = value;
        return true;
      }
      return false;
    case "status":
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        output.status = value;
        return true;
      }
      return false;
    default:
      return false;
  }
}

function readMetric(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_METRIC_VALUE
    ? value
    : undefined;
}

function readSafeErrorCode(value: unknown): SafeErrorCode | undefined {
  return typeof value === "string" && safeErrorCodeSet.has(value as SafeErrorCode)
    ? (value as SafeErrorCode)
    : undefined;
}
