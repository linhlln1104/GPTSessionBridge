import { describe, expect, it } from "vitest";

import type { ModelCatalogError } from "../src/catalog/errors.js";
import { OpaqueCursorStore } from "../src/catalog/opaque-cursor-store.js";

describe("opaque model catalog cursor store", () => {
  it("keeps cursor payloads opaque and evicts the oldest bounded entry", () => {
    let sequence = 0;
    const store = new OpaqueCursorStore<string>({
      maxEntries: 2,
      now: () => 1_000,
      random: () => `entropy_${String((sequence += 1)).padStart(16, "0")}`,
      ttlMs: 5_000,
    });

    const first = store.create("FIRST_MODEL_CANARY");
    const second = store.create("SECOND_MODEL_CANARY");
    const third = store.create("THIRD_MODEL_CANARY");

    expect(first).not.toContain("FIRST_MODEL_CANARY");
    expect(store.activeSize()).toBe(2);
    expect(() => store.read(first)).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_cursor" }),
    );
    expect(store.read(second)).toBe("SECOND_MODEL_CANARY");
    expect(store.read(third)).toBe("THIRD_MODEL_CANARY");
  });

  it("rejects tampered and expired cursors", () => {
    let now = 10_000;
    const store = new OpaqueCursorStore<string>({
      maxEntries: 2,
      now: () => now,
      random: () => "fixed_entropy_0000000000000001",
      ttlMs: 100,
    });
    const cursor = store.create("state");

    expect(() => store.read(`${cursor}tampered`)).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_cursor" }),
    );

    now += 100;
    expect(() => store.read(cursor)).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "cursor_expired" }),
    );
  });

  it("validates its injected clock, entropy, and bounds", () => {
    expect(
      () =>
        new OpaqueCursorStore({
          maxEntries: 0,
          now: () => 0,
          random: () => "entropy_0000000000000000",
          ttlMs: 100,
        }),
    ).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_configuration" }),
    );

    const store = new OpaqueCursorStore({
      maxEntries: 1,
      now: () => 0,
      random: () => "too-short",
      ttlMs: 100,
    });
    expect(() => store.create({})).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "cursor_generation_failed" }),
    );
  });
});
