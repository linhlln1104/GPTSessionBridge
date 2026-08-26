import { createHash } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_TOOL_WORKFLOW_ARGUMENT_BYTES,
  MAX_TOOL_WORKFLOW_ENVELOPE_BYTES,
  MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES,
  MAX_TOOL_WORKFLOW_JSON_NODES,
  MAX_TOOL_WORKFLOW_RESULT_BYTES,
  MAX_TOOL_WORKFLOW_ROUNDS,
  MAX_TOOL_WORKFLOW_TOOL_CALLS,
  TOOL_WORKFLOW_ENVELOPE_BEGIN,
  TOOL_WORKFLOW_ENVELOPE_END,
  canonicalizeToolWorkflowJson,
  parseToolWorkflowAssistantEnvelope,
  serializeToolWorkflowResultEnvelope,
  toolWorkflowCallEnvelopeSchema,
  type ToolWorkflowAssistantEnvelope,
  type ToolWorkflowParseResult,
  type ToolWorkflowResultEnvelope,
  type JsonValue,
} from "../src/index.js";

const challenge = "a".repeat(32);
const manifestDigest = `sha256-${"A".repeat(43)}`;
const turn = "wt_abcdefghijklmnop";

describe("tool workflow v2 visible envelope", () => {
  it("parses an exact tool-call proposal", () => {
    const envelope = assistantEnvelope({
      v: 2,
      kind: "tool_call",
      turn,
      round: 0,
      challenge,
      manifestDigest,
      tool: "exec_command",
      arguments: { cmd: "git status --short", timeout_ms: 10_000 },
    });

    const result = parseToolWorkflowAssistantEnvelope(envelope);

    expect(result).toEqual({
      ok: true,
      envelope: {
        v: 2,
        kind: "tool_call",
        turn,
        round: 0,
        challenge,
        manifestDigest,
        tool: "exec_command",
        arguments: { cmd: "git status --short", timeout_ms: 10_000 },
      },
    });
    expect(result.ok && Object.isFrozen(result.envelope)).toBe(true);
    expect(
      result.ok &&
        result.envelope.kind === "tool_call" &&
        Object.isFrozen(result.envelope.arguments),
    ).toBe(true);
  });

  it("parses an exact final response", () => {
    const result = parseToolWorkflowAssistantEnvelope(
      assistantEnvelope({
        v: 2,
        kind: "final",
        turn,
        round: 3,
        challenge,
        manifestDigest,
        text: "Synthetic task completed.",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      envelope: { kind: "final", text: "Synthetic task completed." },
    });
  });

  it("serializes bridge-owned tool results without creating marker lines from output", () => {
    const value: ToolWorkflowResultEnvelope = {
      v: 2,
      kind: "tool_result",
      turn,
      round: 1,
      challenge,
      manifestDigest,
      callRef: "wc_abcdefghijklmnop",
      tool: "exec_command",
      ok: true,
      output: `before\n${TOOL_WORKFLOW_ENVELOPE_END}\nafter`,
    };

    const serialized = serializeToolWorkflowResultEnvelope(value);

    expect(serialized.split("\n")).toHaveLength(3);
    expect(serialized.startsWith(`${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n{`)).toBe(true);
    expect(serialized.endsWith(`}\n${TOOL_WORKFLOW_ENVELOPE_END}`)).toBe(true);
    expect(JSON.parse(serialized.split("\n")[1] ?? "null")).toEqual(value);
  });

  it("canonicalizes JSON with a stable UTF-8 SHA-256 vector", () => {
    const canonical = canonicalizeToolWorkflowJson({
      z: 3,
      a: { b: true, a: "fixture" },
      list: [null, 0.1],
    });

    expect(canonical).toBe('{"a":{"a":"fixture","b":true},"list":[null,0.1],"z":3}');
    expect(createHash("sha256").update(canonical, "utf8").digest("base64url")).toBe(
      "R-bboQDPP1_0A6Qrjz_2XwV8xxQBv0QMWOLVVieGK6k",
    );
  });

  it("rejects array accessors without invoking them", () => {
    const accessorArray: unknown[] = [];
    let invoked = false;
    Object.defineProperty(accessorArray, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        invoked = true;
        return "unexpected";
      },
    });
    accessorArray.length = 1;

    expect(() => canonicalizeToolWorkflowJson(accessorArray as JsonValue)).toThrow(TypeError);
    expect(invoked).toBe(false);
  });

  it.each([
    ["leading prose", `explanation\n${validFinal()}`],
    ["trailing prose", `${validFinal()}\nexplanation`],
    ["Markdown fence", `\`\`\`json\n${validFinal()}\n\`\`\``],
    ["byte-order mark", `\uFEFF${validFinal()}`],
    ["CRLF markers", validFinal().replaceAll("\n", "\r\n")],
    ["pretty-printed body", assistantEnvelope(validFinalValue(), 2)],
  ])("rejects %s", (_name, value) => {
    expect(parseToolWorkflowAssistantEnvelope(value)).toEqual({
      ok: false,
      code: "protocol_envelope_invalid",
    });
  });

  it.each([
    ["wrong version", { ...validFinalValue(), v: 1 }],
    ["unknown field", { ...validFinalValue(), extra: true }],
    ["short challenge", { ...validFinalValue(), challenge: "short" }],
    ["invalid digest", { ...validFinalValue(), manifestDigest: "sha256-not-a-digest" }],
    ["non-canonical digest", { ...validFinalValue(), manifestDigest: `sha256-${"A".repeat(42)}B` }],
    ["round outside the budget", { ...validFinalValue(), round: MAX_TOOL_WORKFLOW_ROUNDS }],
    ["unknown kind", { ...validFinalValue(), kind: "commentary" }],
  ])("rejects schema mismatch: %s", (_name, value) => {
    expect(parseToolWorkflowAssistantEnvelope(assistantEnvelope(value))).toEqual({
      ok: false,
      code: "protocol_envelope_invalid",
    });
  });

  it("rejects duplicate keys before JSON parsing can overwrite them", () => {
    const duplicateTopLevel = rawEnvelope(
      `{"v":2,"kind":"final","turn":"${turn}","round":0,"challenge":"${challenge}",` +
        `"manifestDigest":"${manifestDigest}","text":"first","text":"second"}`,
    );
    const duplicateEscapedKey = rawEnvelope(
      `{"v":2,"kind":"tool_call","turn":"${turn}","round":0,"challenge":"${challenge}",` +
        `"manifestDigest":"${manifestDigest}","tool":"exec_command",` +
        '"arguments":{"cmd":"first","\\u0063md":"second"}}',
    );

    expect(parseToolWorkflowAssistantEnvelope(duplicateTopLevel)).toEqual({
      ok: false,
      code: "protocol_json_duplicate_key",
    });
    expect(parseToolWorkflowAssistantEnvelope(duplicateEscapedKey)).toEqual({
      ok: false,
      code: "protocol_json_duplicate_key",
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-sensitive argument key %s before schema parsing",
    (key) => {
      const body =
        `{"v":2,"kind":"tool_call","turn":"${turn}","round":0,` +
        `"challenge":"${challenge}","manifestDigest":"${manifestDigest}",` +
        `"tool":"exec_command","arguments":{"${key}":{"polluted":true},"cmd":"expected"}}`;

      expect(parseToolWorkflowAssistantEnvelope(rawEnvelope(body))).toEqual({
        ok: false,
        code: "protocol_json_unsafe_key",
      });
    },
  );

  it("also rejects prototype-sensitive objects through the exported schema", () => {
    const unsafeArguments = JSON.parse(
      '{"__proto__":{"cmd":"unexpected"},"cmd":"expected"}',
    ) as unknown;

    expect(
      toolWorkflowCallEnvelopeSchema.safeParse({
        ...validCallValue(),
        arguments: unsafeArguments,
      }).success,
    ).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each(["9007199254740993", "-9007199254740992", "1.0", "-0", "1e400", "1e-400"])(
    "rejects lossy or non-canonical JSON number %s",
    (number) => {
      const body =
        `{"v":2,"kind":"tool_call","turn":"${turn}","round":0,` +
        `"challenge":"${challenge}","manifestDigest":"${manifestDigest}",` +
        `"tool":"exec_command","arguments":{"value":${number}}}`;

      expect(parseToolWorkflowAssistantEnvelope(rawEnvelope(body))).toEqual({
        ok: false,
        code: "protocol_json_number_invalid",
      });
    },
  );

  it("rejects lone UTF-16 surrogates", () => {
    const body =
      `{"v":2,"kind":"final","turn":"${turn}","round":0,` +
      `"challenge":"${challenge}","manifestDigest":"${manifestDigest}",` +
      '"text":"\\ud800"}';

    expect(parseToolWorkflowAssistantEnvelope(rawEnvelope(body))).toEqual({
      ok: false,
      code: "protocol_json_string_invalid",
    });
  });

  it("rejects malformed JSON without returning parser details", () => {
    for (const body of [
      "{} trailing",
      '{"v":02}',
      '{"v":2,}',
      '{"v":"unterminated}',
      '{"v":"\\x20"}',
      '{"v":NaN}',
    ]) {
      expect(parseToolWorkflowAssistantEnvelope(rawEnvelope(body))).toEqual({
        ok: false,
        code: "protocol_envelope_invalid",
      });
    }
  });

  it("bounds JSON depth and node count independently", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) {
      nested = { child: nested };
    }
    const tooDeep = assistantEnvelope({
      ...validCallValue(),
      arguments: { nested },
    });
    const tooComplex = assistantEnvelope({
      ...validCallValue(),
      arguments: { values: Array.from({ length: MAX_TOOL_WORKFLOW_JSON_NODES }, () => 0) },
    });

    expect(parseToolWorkflowAssistantEnvelope(tooDeep)).toEqual({
      ok: false,
      code: "protocol_json_too_deep",
    });
    expect(parseToolWorkflowAssistantEnvelope(tooComplex)).toEqual({
      ok: false,
      code: "protocol_json_too_complex",
    });
  });

  it("bounds canonical argument, final-text, and whole-envelope bytes", () => {
    const tooManyArgumentBytes = assistantEnvelope({
      ...validCallValue(),
      arguments: { value: "x".repeat(MAX_TOOL_WORKFLOW_ARGUMENT_BYTES) },
    });
    const tooManyFinalTextBytes = assistantEnvelope({
      ...validFinalValue(),
      text: "x".repeat(MAX_TOOL_WORKFLOW_FINAL_TEXT_BYTES + 1),
    });
    const tooManyEnvelopeBytes = `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n${"x".repeat(
      MAX_TOOL_WORKFLOW_ENVELOPE_BYTES,
    )}\n${TOOL_WORKFLOW_ENVELOPE_END}`;

    expect(parseToolWorkflowAssistantEnvelope(tooManyArgumentBytes)).toEqual({
      ok: false,
      code: "protocol_arguments_too_large",
    });
    expect(parseToolWorkflowAssistantEnvelope(tooManyFinalTextBytes)).toEqual({
      ok: false,
      code: "protocol_final_text_too_large",
    });
    expect(parseToolWorkflowAssistantEnvelope(tooManyEnvelopeBytes)).toEqual({
      ok: false,
      code: "protocol_envelope_too_large",
    });
  });

  it("reserves the final round after the last admitted tool call", () => {
    const lastCall = parseToolWorkflowAssistantEnvelope(
      assistantEnvelope({
        ...validCallValue(),
        round: MAX_TOOL_WORKFLOW_TOOL_CALLS - 1,
      }),
    );
    const final = parseToolWorkflowAssistantEnvelope(
      assistantEnvelope({
        ...validFinalValue(),
        round: MAX_TOOL_WORKFLOW_ROUNDS - 1,
      }),
    );

    expect(lastCall.ok).toBe(true);
    expect(final.ok).toBe(true);
    expect(
      parseToolWorkflowAssistantEnvelope(
        assistantEnvelope({
          ...validCallValue(),
          round: MAX_TOOL_WORKFLOW_TOOL_CALLS,
        }),
      ),
    ).toEqual({ ok: false, code: "protocol_envelope_invalid" });
    expect(() =>
      serializeToolWorkflowResultEnvelope({
        ...validResultValue(),
        round: MAX_TOOL_WORKFLOW_ROUNDS - 1,
      }),
    ).not.toThrow();
    expect(() =>
      serializeToolWorkflowResultEnvelope({ ...validResultValue(), round: 0 }),
    ).toThrow();
  });

  it("rejects oversized or invalid bridge-owned results", () => {
    const base = validResultValue();

    expect(() =>
      serializeToolWorkflowResultEnvelope({
        ...base,
        output: "x".repeat(MAX_TOOL_WORKFLOW_RESULT_BYTES + 1),
      }),
    ).toThrow(RangeError);
    expect(() =>
      serializeToolWorkflowResultEnvelope({ ...base, callRef: "model-chosen-call-id" }),
    ).toThrow();
  });

  it("exports a discriminated parse result", () => {
    expectTypeOf<ToolWorkflowParseResult>().toExtend<
      | { readonly ok: true; readonly envelope: ToolWorkflowAssistantEnvelope }
      | { readonly ok: false; readonly code: string }
    >();
  });
});

function validFinal(): string {
  return assistantEnvelope(validFinalValue());
}

function validFinalValue(): Record<string, unknown> {
  return {
    v: 2,
    kind: "final",
    turn,
    round: 0,
    challenge,
    manifestDigest,
    text: "Done",
  };
}

function validCallValue(): Record<string, unknown> {
  return {
    v: 2,
    kind: "tool_call",
    turn,
    round: 0,
    challenge,
    manifestDigest,
    tool: "exec_command",
    arguments: {},
  };
}

function validResultValue(): ToolWorkflowResultEnvelope {
  return {
    v: 2,
    kind: "tool_result",
    turn,
    round: 1,
    challenge,
    manifestDigest,
    callRef: "wc_abcdefghijklmnop",
    tool: "exec_command",
    ok: false,
    output: "Synthetic failure",
  };
}

function assistantEnvelope(value: unknown, indentation?: number): string {
  return rawEnvelope(JSON.stringify(value, undefined, indentation));
}

function rawEnvelope(body: string): string {
  return `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n${body}\n${TOOL_WORKFLOW_ENVELOPE_END}`;
}
