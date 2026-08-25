import { redactErrorMetadata, type RedactedErrorMetadata } from "./redaction.js";
import {
  assertExactKeys,
  hasOwn,
  readEnum,
  readInteger,
  toDataRecord,
} from "./internal/validation.js";

export const DIAGNOSTIC_COMPONENTS = [
  "adapter",
  "core",
  "extension",
  "facade",
  "native-host",
] as const;
export const DIAGNOSTIC_TRANSPORTS = [
  "browser-tab",
  "loopback-http",
  "native-messaging",
  "stdio",
] as const;
export const DIAGNOSTIC_OPERATIONS = [
  "bridge-health",
  "model-list",
  "thread-start",
  "turn-cancel",
  "turn-start",
] as const;
export const DIAGNOSTIC_OUTCOMES = ["cancelled", "failed", "ok", "rejected"] as const;
export const DIAGNOSTIC_SECURITY_RULES = [
  "invalid-host",
  "invalid-origin",
  "invalid-token",
  "message-too-large",
  "protocol-mismatch",
  "rate-limited",
  "replay-detected",
  "request-timeout",
] as const;
export const DIAGNOSTIC_ERROR_CODES = [
  "internal",
  "invalid-message",
  "timeout",
  "transport-failure",
  "upstream-unavailable",
] as const;

export type DiagnosticComponent = (typeof DIAGNOSTIC_COMPONENTS)[number];
export type DiagnosticTransport = (typeof DIAGNOSTIC_TRANSPORTS)[number];
export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];
export type DiagnosticSecurityRule = (typeof DIAGNOSTIC_SECURITY_RULES)[number];
export type DiagnosticErrorCode = (typeof DIAGNOSTIC_ERROR_CODES)[number];
export type DiagnosticLevel = "error" | "info" | "warn";

interface DiagnosticEventBase {
  readonly component: DiagnosticComponent;
  readonly level: DiagnosticLevel;
  readonly timestamp: string;
}

export interface ProcessStartedDiagnosticEvent extends DiagnosticEventBase {
  readonly level: "info";
  readonly name: "process.started";
}

export interface ProcessStoppedDiagnosticEvent extends DiagnosticEventBase {
  readonly level: "info";
  readonly name: "process.stopped";
  readonly reason: "normal" | "parent-exit" | "startup-failure";
}

export interface TransportStateDiagnosticEvent extends DiagnosticEventBase {
  readonly level: "info";
  readonly name: "transport.state";
  readonly state: "connected" | "disconnected";
  readonly transport: DiagnosticTransport;
}

export interface OperationCompletedDiagnosticEvent extends DiagnosticEventBase {
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly level: "info";
  readonly name: "operation.completed";
  readonly operation: DiagnosticOperation;
  readonly outcome: DiagnosticOutcome;
  readonly outputBytes: number;
}

export interface SecurityRejectedDiagnosticEvent extends DiagnosticEventBase {
  readonly level: "warn";
  readonly name: "security.rejected";
  readonly rule: DiagnosticSecurityRule;
  readonly transport: DiagnosticTransport;
}

export interface ErrorObservedDiagnosticEvent extends DiagnosticEventBase {
  readonly code: DiagnosticErrorCode;
  readonly level: "error";
  readonly metadata: RedactedErrorMetadata;
  readonly name: "error.observed";
}

export type DiagnosticEvent =
  | ErrorObservedDiagnosticEvent
  | OperationCompletedDiagnosticEvent
  | ProcessStartedDiagnosticEvent
  | ProcessStoppedDiagnosticEvent
  | SecurityRejectedDiagnosticEvent
  | TransportStateDiagnosticEvent;

export interface DiagnosticSink {
  write(event: DiagnosticEvent): Promise<void> | void;
}

export interface DiagnosticOperationMetrics {
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
}

export type DiagnosticClock = () => Date;

const components = new Set<DiagnosticComponent>(DIAGNOSTIC_COMPONENTS);
const transports = new Set<DiagnosticTransport>(DIAGNOSTIC_TRANSPORTS);
const operations = new Set<DiagnosticOperation>(DIAGNOSTIC_OPERATIONS);
const outcomes = new Set<DiagnosticOutcome>(DIAGNOSTIC_OUTCOMES);
const securityRules = new Set<DiagnosticSecurityRule>(DIAGNOSTIC_SECURITY_RULES);
const errorCodes = new Set<DiagnosticErrorCode>(DIAGNOSTIC_ERROR_CODES);
const stopReasons = new Set(["normal", "parent-exit", "startup-failure"] as const);
const transportStates = new Set(["connected", "disconnected"] as const);

const BASE_KEYS = ["component", "level", "name", "timestamp"] as const;
const MAX_DURATION_MS = 2_147_483_647;
const MAX_BYTE_COUNT = Number.MAX_SAFE_INTEGER;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class SafeDiagnosticLogger {
  readonly #clock: DiagnosticClock;
  readonly #sink: DiagnosticSink;

  public constructor(sink: DiagnosticSink, clock: DiagnosticClock = () => new Date()) {
    this.#sink = sink;
    this.#clock = clock;
  }

  public processStarted(component: DiagnosticComponent): Promise<void> {
    return this.#emit({
      component,
      level: "info",
      name: "process.started",
      timestamp: this.#timestamp(),
    });
  }

  public processStopped(
    component: DiagnosticComponent,
    reason: ProcessStoppedDiagnosticEvent["reason"],
  ): Promise<void> {
    return this.#emit({
      component,
      level: "info",
      name: "process.stopped",
      reason,
      timestamp: this.#timestamp(),
    });
  }

  public transportState(
    component: DiagnosticComponent,
    transport: DiagnosticTransport,
    state: TransportStateDiagnosticEvent["state"],
  ): Promise<void> {
    return this.#emit({
      component,
      level: "info",
      name: "transport.state",
      state,
      timestamp: this.#timestamp(),
      transport,
    });
  }

  public operationCompleted(
    component: DiagnosticComponent,
    operation: DiagnosticOperation,
    outcome: DiagnosticOutcome,
    metrics: DiagnosticOperationMetrics,
  ): Promise<void> {
    return this.#emit({
      component,
      durationMs: metrics.durationMs,
      inputBytes: metrics.inputBytes,
      level: "info",
      name: "operation.completed",
      operation,
      outcome,
      outputBytes: metrics.outputBytes,
      timestamp: this.#timestamp(),
    });
  }

  public securityRejected(
    component: DiagnosticComponent,
    rule: DiagnosticSecurityRule,
    transport: DiagnosticTransport,
  ): Promise<void> {
    return this.#emit({
      component,
      level: "warn",
      name: "security.rejected",
      rule,
      timestamp: this.#timestamp(),
      transport,
    });
  }

  public errorObserved(
    component: DiagnosticComponent,
    code: DiagnosticErrorCode,
    unsafeMetadata: unknown,
  ): Promise<void> {
    return this.#emit({
      code,
      component,
      level: "error",
      metadata: unsafeMetadata,
      name: "error.observed",
      timestamp: this.#timestamp(),
    });
  }

  #timestamp(): string {
    const clockValue = this.#clock();
    const timestamp = new Date(clockValue.getTime()).toISOString();
    return timestamp;
  }

  async #emit(value: unknown): Promise<void> {
    const event = parseDiagnosticEvent(value);
    await this.#sink.write(event);
  }
}

export const diagnosticEventSchema = Object.freeze({
  parse: parseDiagnosticEvent,
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: DiagnosticEvent } | { readonly success: false } {
    try {
      return { data: parseDiagnosticEvent(value), success: true };
    } catch {
      return { success: false };
    }
  },
});

export function parseDiagnosticEvent(value: unknown): DiagnosticEvent {
  const record = toDataRecord(value);
  const name = record["name"];

  switch (name) {
    case "process.started":
      assertExactKeys(record, keySet());
      return freezeEvent({
        ...parseBase(record, "info"),
        level: "info",
        name,
      });
    case "process.stopped":
      assertExactKeys(record, keySet("reason"));
      return freezeEvent({
        ...parseBase(record, "info"),
        level: "info",
        name,
        reason: readEnum(record["reason"], stopReasons),
      });
    case "transport.state":
      assertExactKeys(record, keySet("state", "transport"));
      return freezeEvent({
        ...parseBase(record, "info"),
        level: "info",
        name,
        state: readEnum(record["state"], transportStates),
        transport: readEnum(record["transport"], transports),
      });
    case "operation.completed":
      assertExactKeys(
        record,
        keySet("durationMs", "inputBytes", "operation", "outcome", "outputBytes"),
      );
      return freezeEvent({
        ...parseBase(record, "info"),
        durationMs: readInteger(record["durationMs"], 0, MAX_DURATION_MS),
        inputBytes: readInteger(record["inputBytes"], 0, MAX_BYTE_COUNT),
        level: "info",
        name,
        operation: readEnum(record["operation"], operations),
        outcome: readEnum(record["outcome"], outcomes),
        outputBytes: readInteger(record["outputBytes"], 0, MAX_BYTE_COUNT),
      });
    case "security.rejected":
      assertExactKeys(record, keySet("rule", "transport"));
      return freezeEvent({
        ...parseBase(record, "warn"),
        level: "warn",
        name,
        rule: readEnum(record["rule"], securityRules),
        transport: readEnum(record["transport"], transports),
      });
    case "error.observed": {
      assertExactKeys(record, keySet("code", "metadata"));
      if (!hasOwn(record, "metadata")) {
        throw new TypeError("Invalid diagnostic event");
      }
      const metadata = redactErrorMetadata(record["metadata"]);
      return freezeEvent({
        ...parseBase(record, "error"),
        code: readEnum(record["code"], errorCodes),
        level: "error",
        metadata,
        name,
      });
    }
    default:
      throw new TypeError("Invalid diagnostic event");
  }
}

export function serializeDiagnosticEvent(value: unknown): string {
  return JSON.stringify(parseDiagnosticEvent(value));
}

function parseBase(
  record: Readonly<Record<string, unknown>>,
  expectedLevel: DiagnosticLevel,
): Pick<DiagnosticEventBase, "component" | "timestamp"> {
  if (record["level"] !== expectedLevel) {
    throw new TypeError("Invalid diagnostic event");
  }

  return {
    component: readEnum(record["component"], components),
    timestamp: readTimestamp(record["timestamp"]),
  };
}

function readTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    throw new TypeError("Invalid diagnostic event");
  }

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError("Invalid diagnostic event");
  }

  return value;
}

function keySet(...keys: readonly string[]): ReadonlySet<string> {
  return new Set([...BASE_KEYS, ...keys]);
}

function freezeEvent<T extends DiagnosticEvent>(event: T): T {
  return Object.freeze(event);
}
