import type { JsonObject } from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  isCertifiedToolParametersSchema,
  matchesCertifiedToolArguments,
} from "../src/tooling/certified-tool-schema.js";

describe("certified tool schema meta-validation", () => {
  it("accepts closed root objects with exact or optional declared properties", () => {
    expect(isCertifiedToolParametersSchema(objectSchema({}))).toBe(true);
    expect(
      isCertifiedToolParametersSchema(
        objectSchema({
          count: { type: "integer" },
          label: { minLength: 1, type: "string" },
        }),
      ),
    ).toBe(true);
    expect(
      isCertifiedToolParametersSchema({
        additionalProperties: false,
        properties: { optional: { type: "string" }, required: { type: "integer" } },
        required: ["required"],
        type: "object",
      }),
    ).toBe(true);
    expect(
      isCertifiedToolParametersSchema({
        additionalProperties: false,
        properties: { optional: { type: "string" } },
        type: "object",
      }),
    ).toBe(true);

    for (const schema of [
      { type: "string" },
      { properties: {}, required: [], additionalProperties: false },
      { type: ["object", "null"], properties: {}, required: [], additionalProperties: false },
      { type: "object", properties: {}, required: [] },
      { type: "object", properties: {}, required: [], additionalProperties: true },
      {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["missing"],
        additionalProperties: false,
      },
    ]) {
      expect(isCertifiedToolParametersSchema(schema)).toBe(false);
    }
  });

  it("validates nested closed objects and homogeneous array items", () => {
    const nested = objectSchema({
      jobs: {
        items: objectSchema({
          command: { minLength: 1, type: "string" },
          environment: objectSchema({
            name: { type: "string" },
          }),
        }),
        maxItems: 4,
        type: "array",
      },
    });
    expect(isCertifiedToolParametersSchema(nested)).toBe(true);

    for (const child of [
      { type: "array" },
      { type: "array", items: "string" },
      { type: "string", items: { type: "string" } },
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        items: { type: "string" },
      },
      { type: "string", properties: {}, required: [], additionalProperties: false },
    ]) {
      expect(isCertifiedToolParametersSchema(objectSchema({ value: child }))).toBe(false);
    }
  });

  it("supports unique type unions and nullable nested values", () => {
    for (const type of ["array", "boolean", "integer", "null", "number", "object", "string"]) {
      const child =
        type === "array"
          ? { items: { type: "string" }, type }
          : type === "object"
            ? objectSchema({})
            : { type };
      expect(isCertifiedToolParametersSchema(objectSchema({ value: child }))).toBe(true);
    }
    expect(
      isCertifiedToolParametersSchema(
        objectSchema({ value: { minLength: 1, type: ["string", "null"] } }),
      ),
    ).toBe(true);

    for (const type of [[], ["string", "string"], ["string", "unknown"], ["string", 1]]) {
      expect(isCertifiedToolParametersSchema(objectSchema({ value: { type } }))).toBe(false);
    }
  });

  it("validates enum, const, and composition schemas", () => {
    const schema = objectSchema({
      mode: {
        allOf: [{ type: "string" }, { not: { const: "blocked" } }],
        anyOf: [{ const: "fast" }, { const: "safe" }],
        enum: ["fast", "safe"],
        oneOf: [{ const: "fast" }, { const: "safe" }],
        type: "string",
      },
    });
    expect(isCertifiedToolParametersSchema(schema)).toBe(true);

    for (const child of [
      { enum: [], type: "string" },
      { enum: ["same", "same"], type: "string" },
      {
        enum: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
      },
      { allOf: [], type: "string" },
      { anyOf: "invalid", type: "string" },
      { oneOf: [{ $ref: "#" }], type: "string" },
      { not: "invalid", type: "string" },
    ]) {
      expect(isCertifiedToolParametersSchema(objectSchema({ value: child }))).toBe(false);
    }
  });

  it("enforces bound types, ordering, multipleOf, and keyword applicability", () => {
    expect(
      isCertifiedToolParametersSchema(
        objectSchema({
          list: {
            items: { type: "integer" },
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            type: "array",
          },
          number: { exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 0.5, type: "number" },
          record: {
            ...objectSchema({ value: { type: "string" } }),
            minProperties: 1,
            maxProperties: 1,
          },
          text: { minLength: 1, maxLength: 4, type: "string" },
        }),
      ),
    ).toBe(true);

    for (const child of [
      { minLength: -1, type: "string" },
      { maxItems: 1.5, items: { type: "string" }, type: "array" },
      { minProperties: Number.MAX_SAFE_INTEGER + 1, ...objectSchema({}) },
      { minimum: Number.POSITIVE_INFINITY, type: "number" },
      { multipleOf: 0, type: "number" },
      { multipleOf: -1, type: "integer" },
      { minLength: 3, maxLength: 2, type: "string" },
      { minItems: 2, maxItems: 1, items: { type: "string" }, type: "array" },
      { minimum: 2, maximum: 1, type: "number" },
      { exclusiveMinimum: 2, exclusiveMaximum: 1, type: "number" },
      { uniqueItems: "true", items: { type: "string" }, type: "array" },
      { minLength: 1, type: "number" },
      { minItems: 1, type: "string" },
      { minimum: 1, type: "string" },
      { minProperties: 1, type: "string" },
    ]) {
      expect(isCertifiedToolParametersSchema(objectSchema({ value: child }))).toBe(false);
    }
  });

  it("rejects unknown, reference, unsafe, symbol, accessor, and exotic schema records", () => {
    let getterCalls = 0;
    const accessor: Record<string, unknown> = { type: "string" };
    Object.defineProperty(accessor, "description", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "hidden";
      },
    });
    const symbol: Record<PropertyKey, unknown> = { type: "string" };
    symbol[Symbol("schema")] = true;
    const unsafe = JSON.parse('{"type":"string","constructor":true}') as unknown;
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic["type"] = "string";

    for (const child of [
      { type: "string", unknownKeyword: true },
      { type: "string", $ref: "#/definitions/value" },
      accessor,
      symbol,
      unsafe,
      exotic,
    ]) {
      expect(isCertifiedToolParametersSchema(objectSchema({ value: child as JsonObject }))).toBe(
        false,
      );
    }
    expect(getterCalls).toBe(0);

    const rootSymbol = objectSchema({});
    (rootSymbol as Record<PropertyKey, unknown>)[Symbol("root")] = true;
    expect(isCertifiedToolParametersSchema(rootSymbol)).toBe(false);
  });

  it("requires bounded nonempty descriptions", () => {
    expect(
      isCertifiedToolParametersSchema(
        objectSchema({ value: { description: "value", type: "string" } }),
      ),
    ).toBe(true);
    expect(
      isCertifiedToolParametersSchema(objectSchema({ value: { description: "", type: "string" } })),
    ).toBe(false);
    expect(
      isCertifiedToolParametersSchema(
        objectSchema({ value: { description: "x".repeat(4_097), type: "string" } }),
      ),
    ).toBe(false);
    expect(
      isCertifiedToolParametersSchema(objectSchema({ value: { description: 1, type: "string" } })),
    ).toBe(false);
  });
});

describe("certified tool argument matching", () => {
  it("requires every declared root property and rejects undeclared properties", () => {
    const schema = objectSchema({
      count: { type: "integer" },
      label: { type: "string" },
    });
    expect(matchesCertifiedToolArguments(schema, { count: 2, label: "ok" })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { count: 2 })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { count: 2, label: "ok", extra: true })).toBe(
      false,
    );
    expect(matchesCertifiedToolArguments(schema, { count: 2.5, label: "ok" })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { count: 2, label: false })).toBe(false);
  });

  it("allows omitted optional properties while still rejecting undeclared properties", () => {
    const schema: JsonObject = {
      additionalProperties: false,
      properties: { optional: { type: "string" }, required: { type: "integer" } },
      required: ["required"],
      type: "object",
    };
    expect(matchesCertifiedToolArguments(schema, { required: 1 })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { optional: "ok", required: 1 })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { optional: "ok" })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { extra: true, required: 1 })).toBe(false);
  });

  it("treats an omitted required list as an all-optional closed object", () => {
    const schema: JsonObject = {
      additionalProperties: false,
      properties: { cursor: { type: "string" } },
      type: "object",
    };
    expect(matchesCertifiedToolArguments(schema, {})).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { cursor: "next" })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { extra: true })).toBe(false);
  });

  it("matches nested arrays and closed objects recursively", () => {
    const schema = objectSchema({
      jobs: {
        items: objectSchema({
          command: { minLength: 1, type: "string" },
          retries: { minimum: 0, maximum: 2, type: "integer" },
        }),
        minItems: 1,
        type: "array",
      },
    });
    expect(
      matchesCertifiedToolArguments(schema, {
        jobs: [
          { command: "build", retries: 1 },
          { command: "test", retries: 0 },
        ],
      }),
    ).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { jobs: [] })).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, {
        jobs: [{ command: "build", retries: 1, shell: "hidden" }],
      }),
    ).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { jobs: [{ command: "", retries: 0 }] })).toBe(
      false,
    );
  });

  it("matches nullable unions without weakening the other union branches", () => {
    const schema = objectSchema({
      value: { minLength: 2, type: ["string", "null"] },
    });
    expect(matchesCertifiedToolArguments(schema, { value: null })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { value: "ok" })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { value: "x" })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { value: 2 })).toBe(false);
  });

  it("matches const and enum using canonical JSON equality", () => {
    const schema = objectSchema({
      exact: { const: { a: 1, b: [true, null] } },
      mode: { enum: ["fast", "safe"], type: "string" },
    });
    expect(
      matchesCertifiedToolArguments(schema, {
        exact: { b: [true, null], a: 1 },
        mode: "safe",
      }),
    ).toBe(true);
    expect(
      matchesCertifiedToolArguments(schema, { exact: { a: 1, b: [true] }, mode: "safe" }),
    ).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, {
        exact: { a: 1, b: [true, null] },
        mode: "other",
      }),
    ).toBe(false);
  });

  it("implements allOf, anyOf, oneOf, and not semantics", () => {
    const schema = objectSchema({
      all: {
        allOf: [
          { minimum: 0, type: "number" },
          { maximum: 10, type: "number" },
        ],
        type: "number",
      },
      any: { anyOf: [{ const: "a" }, { const: "b" }], type: "string" },
      one: {
        oneOf: [
          { minimum: 0, type: "number" },
          { maximum: 10, type: "number" },
        ],
        type: "number",
      },
      permitted: { not: { const: "blocked" }, type: "string" },
    });
    expect(
      matchesCertifiedToolArguments(schema, { all: 5, any: "a", one: -1, permitted: "ok" }),
    ).toBe(true);
    expect(
      matchesCertifiedToolArguments(schema, { all: 11, any: "a", one: -1, permitted: "ok" }),
    ).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, { all: 5, any: "c", one: -1, permitted: "ok" }),
    ).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, { all: 5, any: "a", one: 5, permitted: "ok" }),
    ).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, { all: 5, any: "a", one: -1, permitted: "blocked" }),
    ).toBe(false);
  });

  it("enforces numeric bounds and floating-point multipleOf", () => {
    const schema = objectSchema({
      value: {
        exclusiveMinimum: 0,
        exclusiveMaximum: 1,
        minimum: 0,
        maximum: 1,
        multipleOf: 0.1,
        type: "number",
      },
    });
    expect(matchesCertifiedToolArguments(schema, { value: 0.3 })).toBe(true);
    expect(matchesCertifiedToolArguments(schema, { value: 0 })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { value: 1 })).toBe(false);
    expect(matchesCertifiedToolArguments(schema, { value: 0.31 })).toBe(false);
  });

  it("counts Unicode code points for string length", () => {
    const oneCodePoint = objectSchema({ value: { minLength: 1, maxLength: 1, type: "string" } });
    expect(matchesCertifiedToolArguments(oneCodePoint, { value: "😀" })).toBe(true);
    expect(matchesCertifiedToolArguments(oneCodePoint, { value: "e\u0301" })).toBe(false);

    const twoCodePoints = objectSchema({ value: { minLength: 2, maxLength: 2, type: "string" } });
    expect(matchesCertifiedToolArguments(twoCodePoints, { value: "e\u0301" })).toBe(true);
  });

  it("enforces array and object cardinality plus canonical uniqueItems", () => {
    const schema = objectSchema({
      list: {
        items: objectSchema({ a: { type: "integer" }, b: { type: "integer" } }),
        minItems: 1,
        maxItems: 2,
        type: "array",
        uniqueItems: true,
      },
      record: {
        ...objectSchema({ first: { type: "string" }, second: { type: "string" } }),
        minProperties: 2,
        maxProperties: 2,
      },
    });
    expect(
      matchesCertifiedToolArguments(schema, {
        list: [
          { a: 1, b: 1 },
          { a: 2, b: 2 },
        ],
        record: { first: "a", second: "b" },
      }),
    ).toBe(true);
    expect(
      matchesCertifiedToolArguments(schema, {
        list: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
        record: { first: "a", second: "b" },
      }),
    ).toBe(false);
    expect(
      matchesCertifiedToolArguments(schema, {
        list: [],
        record: { first: "a", second: "b" },
      }),
    ).toBe(false);
  });

  it("rejects noncanonical, unsafe, accessor, symbol, and exotic argument values", () => {
    const schema = objectSchema({ value: {} });
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "hidden";
      },
    });
    const symbol: Record<PropertyKey, unknown> = { value: "ok" };
    symbol[Symbol("argument")] = true;
    const unsafe = JSON.parse('{"value":{"prototype":true}}') as unknown;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic["value"] = "ok";

    for (const value of [
      { value: Number.NaN },
      { value: Number.MAX_SAFE_INTEGER + 1 },
      { value: sparse },
      accessor,
      symbol,
      unsafe,
      exotic,
    ]) {
      expect(matchesCertifiedToolArguments(schema, value)).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });

  it("returns false when the supplied schema is not certified", () => {
    const invalid = {
      type: "object",
      properties: { value: { $ref: "#/value" } },
      required: ["value"],
      additionalProperties: false,
    } as unknown as JsonObject;
    expect(matchesCertifiedToolArguments(invalid, { value: "anything" })).toBe(false);
  });
});

function objectSchema(properties: JsonObject): JsonObject {
  return {
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    type: "object",
  };
}
