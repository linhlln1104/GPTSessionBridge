import {
  canonicalizeToolWorkflowJson,
  type JsonObject,
  type JsonValue,
} from "@gpt-session-bridge/protocol";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);
const NONNEGATIVE_INTEGER_KEYS = [
  "maxItems",
  "maxLength",
  "maxProperties",
  "minItems",
  "minLength",
  "minProperties",
] as const;
const NUMBER_KEYS = [
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
] as const;
const COMPOSITION_KEYS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * Validates the deliberately small, reference-free JSON Schema subset that a
 * certified Web Agent profile may advertise. Objects are always closed and
 * every declared property is required, matching strict Responses tools.
 */
export function isCertifiedToolParametersSchema(value: unknown): value is JsonObject {
  try {
    canonicalizeToolWorkflowJson(value as JsonValue);
    return isSchemaNode(value, true);
  } catch {
    return false;
  }
}

/** Validates arguments against the same schema that is exposed to the child. */
export function matchesCertifiedToolArguments(schema: JsonObject, value: unknown): boolean {
  try {
    if (!isCertifiedToolParametersSchema(schema)) {
      return false;
    }
    canonicalizeToolWorkflowJson(value as JsonValue);
    return matchesSchemaNode(schema, value);
  } catch {
    return false;
  }
}

function isSchemaNode(value: unknown, root: boolean): value is JsonObject {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    !keys.every((key): key is string => typeof key === "string" && SCHEMA_KEYS.has(key)) ||
    (root && value["type"] !== "object")
  ) {
    return false;
  }

  const types = readTypes(value["type"]);
  if (value["type"] !== undefined && types === undefined) {
    return false;
  }
  if (typeof value["description"] !== "undefined" && !isNonemptyText(value["description"])) {
    return false;
  }

  for (const key of NONNEGATIVE_INTEGER_KEYS) {
    const item = value[key];
    if (item !== undefined && !isNonnegativeSafeInteger(item)) {
      return false;
    }
  }
  for (const key of NUMBER_KEYS) {
    const item = value[key];
    if (item !== undefined && !isFiniteSupportedNumber(item)) {
      return false;
    }
  }
  if (value["multipleOf"] !== undefined && (value["multipleOf"] as number) <= 0) {
    return false;
  }
  if (!orderedBounds(value, "minLength", "maxLength")) {
    return false;
  }
  if (!orderedBounds(value, "minItems", "maxItems")) {
    return false;
  }
  if (!orderedBounds(value, "minProperties", "maxProperties")) {
    return false;
  }
  if (!orderedBounds(value, "minimum", "maximum")) {
    return false;
  }
  if (!orderedBounds(value, "exclusiveMinimum", "exclusiveMaximum")) {
    return false;
  }
  if (value["uniqueItems"] !== undefined && typeof value["uniqueItems"] !== "boolean") {
    return false;
  }

  const hasStringType = types?.has("string") === true;
  const hasArrayType = types?.has("array") === true;
  const hasNumericType = types?.has("number") === true || types?.has("integer") === true;
  const hasObjectType = types?.has("object") === true;
  if (
    (hasAnyKey(value, ["maxLength", "minLength"]) && !hasStringType) ||
    (hasAnyKey(value, ["maxItems", "minItems", "uniqueItems"]) && !hasArrayType) ||
    (hasAnyKey(value, NUMBER_KEYS) && !hasNumericType) ||
    (hasAnyKey(value, ["maxProperties", "minProperties"]) && !hasObjectType)
  ) {
    return false;
  }

  if (value["enum"] !== undefined) {
    if (!Array.isArray(value["enum"]) || value["enum"].length === 0) {
      return false;
    }
    const seen = new Set<string>();
    for (const item of value["enum"]) {
      let canonical: string;
      try {
        canonical = canonicalizeToolWorkflowJson(item);
      } catch {
        return false;
      }
      if (seen.has(canonical)) {
        return false;
      }
      seen.add(canonical);
    }
  }

  const properties = value["properties"];
  const required = value["required"];
  const additionalProperties = value["additionalProperties"];
  if (hasObjectType || properties !== undefined || required !== undefined) {
    if (
      !hasObjectType ||
      !isPlainRecord(properties) ||
      !isUniqueStringArray(required) ||
      additionalProperties !== false
    ) {
      return false;
    }
    const propertyKeys = Object.keys(properties);
    if (
      required.length !== propertyKeys.length ||
      !required.every((key) => Object.hasOwn(properties, key))
    ) {
      return false;
    }
    for (const child of Object.values(properties)) {
      if (!isSchemaNode(child, false)) {
        return false;
      }
    }
  } else if (additionalProperties !== undefined) {
    return false;
  }

  const items = value["items"];
  if ((hasArrayType && !isSchemaNode(items, false)) || (!hasArrayType && items !== undefined)) {
    return false;
  }

  for (const key of COMPOSITION_KEYS) {
    const branches = value[key];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || branches.length === 0) {
        return false;
      }
      for (const branch of branches) {
        if (!isSchemaNode(branch, false)) {
          return false;
        }
      }
    }
  }
  if (value["not"] !== undefined && !isSchemaNode(value["not"], false)) {
    return false;
  }

  return true;
}

function matchesSchemaNode(schema: JsonObject, value: unknown): boolean {
  const types = readTypes(schema["type"]);
  if (types !== undefined && ![...types].some((type) => matchesType(type, value))) {
    return false;
  }
  if (schema["const"] !== undefined && !sameJson(schema["const"], value)) {
    return false;
  }
  if (
    schema["enum"] !== undefined &&
    !(schema["enum"] as JsonValue[]).some((candidate) => sameJson(candidate, value))
  ) {
    return false;
  }

  const allOf = schema["allOf"] as JsonObject[] | undefined;
  if (allOf !== undefined && !allOf.every((branch) => matchesSchemaNode(branch, value))) {
    return false;
  }
  const anyOf = schema["anyOf"] as JsonObject[] | undefined;
  if (anyOf !== undefined && !anyOf.some((branch) => matchesSchemaNode(branch, value))) {
    return false;
  }
  const oneOf = schema["oneOf"] as JsonObject[] | undefined;
  if (
    oneOf !== undefined &&
    oneOf.filter((branch) => matchesSchemaNode(branch, value)).length !== 1
  ) {
    return false;
  }
  const not = schema["not"] as JsonObject | undefined;
  if (not !== undefined && matchesSchemaNode(not, value)) {
    return false;
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (!withinOptionalBounds(length, schema["minLength"], schema["maxLength"])) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (
      !withinOptionalBounds(value, schema["minimum"], schema["maximum"]) ||
      (schema["exclusiveMinimum"] !== undefined &&
        value <= (schema["exclusiveMinimum"] as number)) ||
      (schema["exclusiveMaximum"] !== undefined &&
        value >= (schema["exclusiveMaximum"] as number)) ||
      (schema["multipleOf"] !== undefined && !isMultipleOf(value, schema["multipleOf"]))
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    const arrayValue = value as JsonValue[];
    if (!withinOptionalBounds(arrayValue.length, schema["minItems"], schema["maxItems"])) {
      return false;
    }
    if (
      schema["uniqueItems"] === true &&
      new Set(arrayValue.map((item) => canonicalizeToolWorkflowJson(item))).size !==
        arrayValue.length
    ) {
      return false;
    }
    const items = schema["items"] as JsonObject | undefined;
    if (items !== undefined && !arrayValue.every((item) => matchesSchemaNode(items, item))) {
      return false;
    }
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (!withinOptionalBounds(keys.length, schema["minProperties"], schema["maxProperties"])) {
      return false;
    }
    const properties = schema["properties"] as JsonObject | undefined;
    const required = schema["required"] as string[] | undefined;
    if (
      (required !== undefined && !required.every((key) => Object.hasOwn(value, key))) ||
      (schema["additionalProperties"] === false &&
        properties !== undefined &&
        !keys.every((key) => Object.hasOwn(properties, key)))
    ) {
      return false;
    }
    if (properties !== undefined) {
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(value, key) && !matchesSchemaNode(child as JsonObject, value[key])) {
          return false;
        }
      }
    }
  }
  return true;
}

function readTypes(value: unknown): ReadonlySet<string> | undefined {
  if (typeof value === "string") {
    return JSON_SCHEMA_TYPES.has(value) ? new Set([value]) : undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  const types = new Set(value);
  return types.size === value.length && [...types].every((item) => JSON_SCHEMA_TYPES.has(item))
    ? types
    : undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function isPlainRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteSupportedNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function orderedBounds(value: JsonObject, minimumKey: string, maximumKey: string): boolean {
  const minimum = value[minimumKey];
  const maximum = value[maximumKey];
  return (
    minimum === undefined || maximum === undefined || (minimum as number) <= (maximum as number)
  );
}

function hasAnyKey(value: JsonObject, keys: readonly string[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

function withinOptionalBounds(
  value: number,
  minimum: JsonValue | undefined,
  maximum: JsonValue | undefined,
): boolean {
  return (
    (minimum === undefined || value >= (minimum as number)) &&
    (maximum === undefined || value <= (maximum as number))
  );
}

function isMultipleOf(value: number, divisorValue: JsonValue): boolean {
  const divisor = divisorValue as number;
  const quotient = value / divisor;
  return (
    Number.isFinite(quotient) &&
    Math.abs(quotient - Math.round(quotient)) <=
      Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalizeToolWorkflowJson(left as JsonValue) ===
      canonicalizeToolWorkflowJson(right as JsonValue)
    );
  } catch {
    return false;
  }
}
