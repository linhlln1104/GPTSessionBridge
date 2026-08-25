const RECORD_ERROR = "Invalid structured value";

export function toDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(RECORD_ERROR);
  }

  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(RECORD_ERROR);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError(RECORD_ERROR);
      }

      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(RECORD_ERROR);
      }

      record[key] = descriptor.value;
    }

    return record;
  } catch {
    // A proxy trap may contain user data; its error must not cross this boundary as a cause.
    throw new TypeError(RECORD_ERROR);
  }
}

export function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(RECORD_ERROR);
    }
  }
}

export function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readEnum<const T extends string>(value: unknown, allowedValues: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowedValues.has(value as T)) {
    throw new TypeError(RECORD_ERROR);
  }

  return value as T;
}

export function readInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(RECORD_ERROR);
  }

  return value;
}

export function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(RECORD_ERROR);
  }

  return value;
}
