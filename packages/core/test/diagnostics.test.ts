import { describe, expect, it } from "vitest";

import {
  SafeDiagnosticLogger,
  diagnosticEventSchema,
  serializeDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticSink,
} from "../src/security/diagnostics.js";

const FIXED_TIME = new Date("2026-01-02T03:04:05.006Z");

class CollectingSink implements DiagnosticSink {
  public readonly events: DiagnosticEvent[] = [];

  public write(event: DiagnosticEvent): void {
    this.events.push(event);
  }
}

describe("safe diagnostics", () => {
  it("emits only the explicitly defined operation fields", async () => {
    const sink = new CollectingSink();
    const logger = new SafeDiagnosticLogger(sink, () => FIXED_TIME);
    const unsafeMetrics = {
      authorization: "Bearer AUTHORIZATION_CANARY",
      durationMs: 7,
      inputBytes: 11,
      outputBytes: 13,
      prompt: "PROMPT_CANARY",
      response: "RESPONSE_CANARY",
    };

    await logger.operationCompleted("facade", "turn-start", "ok", unsafeMetrics);

    expect(sink.events).toHaveLength(1);
    const serialized = serializeDiagnosticEvent(sink.events[0]);
    expect(serialized).toBe(
      '{"component":"facade","timestamp":"2026-01-02T03:04:05.006Z","durationMs":7,"inputBytes":11,"level":"info","name":"operation.completed","operation":"turn-start","outcome":"ok","outputBytes":13}',
    );
    expect(serialized).not.toContain("AUTHORIZATION_CANARY");
    expect(serialized).not.toContain("PROMPT_CANARY");
    expect(serialized).not.toContain("RESPONSE_CANARY");
  });

  it("removes sensitive error metadata before the sink sees it", async () => {
    const sink = new CollectingSink();
    const logger = new SafeDiagnosticLogger(sink, () => FIXED_TIME);
    const unsafeMetadata = {
      Authorization: "Bearer AUTHORIZATION_CANARY",
      causeCode: "TOKEN_CANARY",
      cookies: "session=COOKIE_CANARY",
      cwd: "/workspace/CWD_CANARY",
      email: "EMAIL_CANARY@example.invalid",
      nested: {
        filePath: "/workspace/PATH_CANARY",
        tokens: ["TOKEN_CANARY"],
      },
      prompt: "PROMPT_CANARY",
      response: "RESPONSE_CANARY",
      retryable: true,
      status: 502,
      token: "TOKEN_CANARY",
    };

    await logger.errorObserved("adapter", "upstream-unavailable", unsafeMetadata);

    expect(sink.events).toHaveLength(1);
    const serialized = serializeDiagnosticEvent(sink.events[0]);
    const forbidden = [
      "AUTHORIZATION_CANARY",
      "COOKIE_CANARY",
      "CWD_CANARY",
      "EMAIL_CANARY",
      "PATH_CANARY",
      "PROMPT_CANARY",
      "RESPONSE_CANARY",
      "TOKEN_CANARY",
      "example.invalid",
      "Bearer",
      "session=",
    ];

    for (const fragment of forbidden) {
      expect(serialized).not.toContain(fragment);
    }
    expect(serialized).toContain('"retryable":true');
    expect(serialized).toContain('"status":502');
    expect(serialized).toContain('"redactedFields":9');
    expect(Object.isFrozen(sink.events[0])).toBe(true);
  });

  it("rejects unknown outer fields without reflecting their names or values", () => {
    const canary = "AUTHORIZATION_CANARY";
    const result = diagnosticEventSchema.safeParse({
      authorization: canary,
      component: "facade",
      level: "info",
      name: "process.started",
      timestamp: FIXED_TIME.toISOString(),
    });

    expect(result).toEqual({ success: false });
    expect(() =>
      serializeDiagnosticEvent({
        authorization: canary,
        component: "facade",
        level: "info",
        name: "process.started",
        timestamp: FIXED_TIME.toISOString(),
      }),
    ).toThrow("Invalid structured value");
  });

  it("does not invoke metadata getters", async () => {
    const sink = new CollectingSink();
    const logger = new SafeDiagnosticLogger(sink, () => FIXED_TIME);
    const metadata = Object.defineProperty({ status: 500 }, "authorization", {
      enumerable: true,
      get(): never {
        throw new Error("GETTER_CANARY");
      },
    });

    await logger.errorObserved("adapter", "internal", metadata);

    const serialized = serializeDiagnosticEvent(sink.events[0]);
    expect(serialized).not.toContain("GETTER_CANARY");
    expect(serialized).not.toContain("authorization");
  });
});
