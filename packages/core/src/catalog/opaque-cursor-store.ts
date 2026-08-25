import { ModelCatalogError } from "./errors.js";

const MAX_CURSOR_GENERATION_ATTEMPTS = 8;
const MIN_ENTROPY_LENGTH = 16;
const MAX_ENTROPY_LENGTH = 256;
const DEFAULT_CURSOR_PREFIX = "gptsb:model-catalog:v1:";

interface StoredCursor<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export interface OpaqueCursorStoreOptions {
  readonly maxEntries: number;
  readonly now: () => number;
  readonly random: () => string;
  readonly ttlMs: number;
  readonly prefix?: string;
}

/**
 * Stores cursor state locally so the cursor itself never contains catalog data.
 */
export class OpaqueCursorStore<T> {
  readonly #entries = new Map<string, StoredCursor<T>>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #prefix: string;
  readonly #random: () => string;
  readonly #ttlMs: number;

  public constructor(options: OpaqueCursorStoreOptions) {
    assertPositiveSafeInteger(options.maxEntries, "maxEntries");
    assertPositiveSafeInteger(options.ttlMs, "ttlMs");

    const prefix = options.prefix ?? DEFAULT_CURSOR_PREFIX;
    if (prefix.length === 0 || prefix.length > 128) {
      throw new ModelCatalogError(
        "invalid_configuration",
        "The cursor prefix must contain between 1 and 128 characters.",
      );
    }

    this.#maxEntries = options.maxEntries;
    this.#now = options.now;
    this.#prefix = prefix;
    this.#random = options.random;
    this.#ttlMs = options.ttlMs;
  }

  public create(value: T): string {
    const now = this.#readNow();
    this.#pruneExpired(now);

    for (let attempt = 0; attempt < MAX_CURSOR_GENERATION_ATTEMPTS; attempt += 1) {
      const entropy = this.#random();
      if (!isValidEntropy(entropy)) {
        throw new ModelCatalogError(
          "cursor_generation_failed",
          "The cursor entropy source returned an invalid value.",
        );
      }

      const cursor = `${this.#prefix}${entropy}`;
      if (this.#entries.has(cursor)) {
        continue;
      }

      this.#evictOldestIfFull();
      this.#entries.set(cursor, {
        expiresAt: safeExpiry(now, this.#ttlMs),
        value,
      });
      return cursor;
    }

    throw new ModelCatalogError(
      "cursor_generation_failed",
      "The cursor entropy source produced too many duplicate values.",
    );
  }

  public read(cursor: string): T {
    if (!this.owns(cursor)) {
      throw new ModelCatalogError("invalid_cursor", "The model catalog cursor is invalid.");
    }

    const now = this.#readNow();
    const stored = this.#entries.get(cursor);
    if (stored === undefined) {
      this.#pruneExpired(now);
      throw new ModelCatalogError("invalid_cursor", "The model catalog cursor is invalid.");
    }

    if (stored.expiresAt <= now) {
      this.#entries.delete(cursor);
      this.#pruneExpired(now);
      throw new ModelCatalogError("cursor_expired", "The model catalog cursor has expired.");
    }

    this.#pruneExpired(now, cursor);
    return stored.value;
  }

  public owns(cursor: unknown): boolean {
    return typeof cursor === "string" && cursor.startsWith(this.#prefix);
  }

  public activeSize(): number {
    this.#pruneExpired(this.#readNow());
    return this.#entries.size;
  }

  #evictOldestIfFull(): void {
    if (this.#entries.size < this.#maxEntries) {
      return;
    }

    const oldest = this.#entries.keys().next();
    if (!oldest.done) {
      this.#entries.delete(oldest.value);
    }
  }

  #pruneExpired(now: number, except?: string): void {
    for (const [cursor, stored] of this.#entries) {
      if (cursor !== except && stored.expiresAt <= now) {
        this.#entries.delete(cursor);
      }
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ModelCatalogError(
        "invalid_configuration",
        "The cursor clock must return a nonnegative safe integer.",
      );
    }
    return now;
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ModelCatalogError(
      "invalid_configuration",
      `${name} must be a positive safe integer.`,
    );
  }
}

function isValidEntropy(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_ENTROPY_LENGTH &&
    value.length <= MAX_ENTROPY_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function safeExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new ModelCatalogError(
      "invalid_configuration",
      "The cursor expiry exceeds the safe integer range.",
    );
  }
  return expiresAt;
}
