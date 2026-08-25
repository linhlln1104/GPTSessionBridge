import { describe, expect, it } from "vitest";

import type { ModelCatalogError } from "../src/catalog/errors.js";
import {
  VirtualModelCatalog,
  type ModelListPage,
  type NativeModelEntry,
  type NativeModelListContext,
  type PreparedModelList,
  type ReturnVirtualModelList,
} from "../src/catalog/model-catalog.js";
import {
  SYNTHETIC_WEB_MODEL_DEFINITION,
  createVirtualModelEntry,
  type VirtualModelDefinition,
} from "../src/catalog/virtual-model.js";

describe("virtual model descriptor", () => {
  it("contains only a public route key and advertises text-only capabilities", () => {
    const model = createVirtualModelEntry(SYNTHETIC_WEB_MODEL_DEFINITION);

    expect(model).toMatchObject({
      additionalSpeedTiers: [],
      availabilityNux: null,
      defaultServiceTier: null,
      id: "gptsessionbridge/web/example-model",
      model: "gptsessionbridge/web/example-model",
      hidden: false,
      inputModalities: ["text"],
      isDefault: false,
      modelSpecialty: null,
      multiAgentVersion: null,
      serviceTiers: [],
      supportsPersonality: false,
      upgrade: null,
      upgradeInfo: null,
    });
    expect(model.defaultReasoningEffort).toBe("medium");
    expect(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(Object.keys(model)).not.toContain("providerModel");
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.supportedReasoningEfforts)).toBe(true);
  });

  it("rejects private-looking keys and inconsistent reasoning metadata", () => {
    expect(() =>
      createVirtualModelEntry({
        ...SYNTHETIC_WEB_MODEL_DEFINITION,
        publicKey: "private-provider-model",
      }),
    ).toThrow(expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_model" }));

    expect(() =>
      createVirtualModelEntry({
        ...SYNTHETIC_WEB_MODEL_DEFINITION,
        defaultReasoningEffort: "unsupported",
      }),
    ).toThrow(expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_model" }));
  });
});

describe("virtual model catalog", () => {
  it("normalizes an omitted native nextCursor as a final page", () => {
    const catalog = createCatalog();
    const merged = catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 2 })), {
      data: [nativeModel("native/without-cursor", true)],
    });

    expect(merged.nextCursor).toBeNull();
    expect(merged.data.map((model) => model.id)).toEqual([
      "native/without-cursor",
      "gptsessionbridge/web/example-model",
    ]);
  });

  it("preserves native data while wrapping pagination state before the final page", () => {
    const catalog = createCatalog();
    const firstRequest = requireNative(catalog.prepare({ cursor: null, limit: 10 }));
    const firstPage = Object.freeze({
      data: Object.freeze([nativeModel("native/one", true)]),
      nextCursor: "native-cursor-2",
    });

    const firstResult = catalog.mergeNativePage(firstRequest, firstPage);
    expect(firstResult.data).toBe(firstPage.data);
    expect(firstResult.nextCursor).not.toBe("native-cursor-2");
    expect(firstResult.nextCursor).not.toContain("native-cursor-2");

    const secondRequest = requireNative(
      catalog.prepare({ cursor: firstResult.nextCursor, limit: 10 }),
    );
    expect(secondRequest.nativeCursor).toBe("native-cursor-2");
    const secondNative = nativeModel("native/two", false);
    const finalResult = catalog.mergeNativePage(secondRequest, {
      catalogRevision: "native-revision",
      data: [secondNative],
      nextCursor: null,
    });

    expect(finalResult.data).toHaveLength(2);
    expect(finalResult.data[0]).toBe(secondNative);
    expect(finalResult.data[1]).toMatchObject({
      id: "gptsessionbridge/web/example-model",
      isDefault: false,
    });
    expect(finalResult.nextCursor).toBeNull();
    expect(finalResult["catalogRevision"]).toBe("native-revision");
  });

  it("keeps native entries and their default marker lossless", () => {
    const catalog = createCatalog();
    const native = nativeModel("native/default", true);
    const page = {
      data: [native],
      nextCursor: null,
    } satisfies ModelListPage;

    const merged = catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 2 })), page);

    expect(merged.data[0]).toBe(native);
    expect(merged.data[0]).toEqual(native);
    expect(merged.data[0]?.isDefault).toBe(true);
    expect(merged.data[1]?.isDefault).toBe(false);
  });

  it.each([
    ["id", { id: "gptsessionbridge/web/example-model", model: "native/model" }],
    ["model", { id: "native/id", model: "gptsessionbridge/web/example-model" }],
  ])("fails closed on an exact native %s collision", (_field, identity) => {
    const catalog = createCatalog();
    const page = {
      data: [{ ...nativeModel("native/base", false), ...identity }],
      nextCursor: null,
    } satisfies ModelListPage;

    expect(() =>
      catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 10 })), page),
    ).toThrow(expect.objectContaining<Partial<ModelCatalogError>>({ code: "model_collision" }));
  });

  it.each([
    { id: "GPTSessionBridge/Web/native", model: "native/model" },
    { id: "native/id", model: " gptsessionbridge/web/native" },
  ])("rejects native entries in the reserved bridge namespace", (identity) => {
    const catalog = createCatalog();
    expect(() =>
      catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 10 })), {
        data: [{ ...nativeModel("native/base", false), ...identity }],
        nextCursor: null,
      }),
    ).toThrow(expect.objectContaining<Partial<ModelCatalogError>>({ code: "model_collision" }));
  });

  it("uses an opaque router cursor when the final native page has no free slot", () => {
    let now = 5_000;
    const catalog = createCatalog({ now: () => now });
    const page = {
      data: [nativeModel("native/one", true)],
      nextCursor: null,
    } satisfies ModelListPage;

    const merged = catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 1 })), page);
    expect(merged.data).toEqual(page.data);
    expect(merged.nextCursor).toEqual(expect.any(String));
    expect(merged.nextCursor).not.toContain("gptsessionbridge/web/example-model");

    const zeroLimit = requireVirtual(catalog.prepare({ cursor: merged.nextCursor, limit: 0 }));
    expect(zeroLimit.page.data).toEqual([
      expect.objectContaining({ id: "gptsessionbridge/web/example-model", isDefault: false }),
    ]);
    expect(zeroLimit.page.nextCursor).toBeNull();

    const virtualPage = requireVirtual(catalog.prepare({ cursor: merged.nextCursor, limit: 1 }));
    expect(virtualPage.page.data).toEqual([
      expect.objectContaining({ id: "gptsessionbridge/web/example-model", isDefault: false }),
    ]);
    expect(virtualPage.page.nextCursor).toBeNull();

    now += 1_001;
    expect(() => catalog.prepare({ cursor: merged.nextCursor, limit: 1 })).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "cursor_expired" }),
    );
  });

  it("rejects tampered bridge cursors instead of forwarding them as native", () => {
    const catalog = createCatalog();
    const merged = catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 1 })), {
      data: [nativeModel("native/full-page", true)],
      nextCursor: null,
    });
    expect(merged.nextCursor).toEqual(expect.any(String));
    if (merged.nextCursor === null) {
      throw new Error("Expected a bridge cursor.");
    }
    const bridgeCursor = merged.nextCursor;

    expect(() => catalog.prepare({ cursor: `${bridgeCursor}tampered`, limit: 1 })).toThrow(
      expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_cursor" }),
    );
  });

  it("does not augment an unknown native continuation without complete collision coverage", () => {
    const catalog = createCatalog();
    const nativeOnly = {
      data: [nativeModel("native/later-page", false)],
      nextCursor: null,
    } satisfies ModelListPage;

    const context = requireNative(catalog.prepare({ cursor: "unknown-native-cursor", limit: 10 }));
    expect(context.completeCollisionCoverage).toBe(false);
    expect(catalog.mergeNativePage(context, nativeOnly)).toBe(nativeOnly);
  });

  it("binds opaque continuation state to one listing and filter", () => {
    const catalog = createCatalog();
    const firstA = catalog.mergeNativePage(
      requireNative(catalog.prepare({ includeHidden: false, limit: 1 })),
      { data: [nativeModel("native/a", true)], nextCursor: "1" },
    );
    const firstB = catalog.mergeNativePage(
      requireNative(catalog.prepare({ includeHidden: true, limit: 1 })),
      { data: [nativeModel("native/b", true)], nextCursor: "1" },
    );

    expect(firstA.nextCursor).not.toBe(firstB.nextCursor);
    const continuationA = requireNative(
      catalog.prepare({ cursor: firstA.nextCursor, includeHidden: false, limit: 1 }),
    );
    const continuationB = requireNative(
      catalog.prepare({ cursor: firstB.nextCursor, includeHidden: true, limit: 1 }),
    );
    expect(continuationA.nativeCursor).toBe("1");
    expect(continuationA.observedIds).toEqual(["native/a"]);
    expect(continuationB.nativeCursor).toBe("1");
    expect(continuationB.observedIds).toEqual(["native/b"]);
    expect(() =>
      catalog.prepare({ cursor: firstA.nextCursor, includeHidden: true, limit: 1 }),
    ).toThrow(expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_cursor" }));
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid limit of %s",
    (limit) => {
      expect(() => createCatalog().prepare({ limit })).toThrow(
        expect.objectContaining<Partial<ModelCatalogError>>({ code: "invalid_limit" }),
      );
    },
  );

  it("paginates multiple synthetic public models without leaking their definitions in cursors", () => {
    const secondModel: VirtualModelDefinition = {
      ...SYNTHETIC_WEB_MODEL_DEFINITION,
      publicKey: "gptsessionbridge/web/second-example",
      displayName: "Web · Second Example",
    };
    const catalog = createCatalog({
      virtualModels: [SYNTHETIC_WEB_MODEL_DEFINITION, secondModel],
    });

    const firstPage = catalog.mergeNativePage(requireNative(catalog.prepare({ limit: 1 })), {
      data: [],
      nextCursor: null,
    });
    expect(firstPage.data.map((model) => model.id)).toEqual(["gptsessionbridge/web/example-model"]);
    expect(firstPage.nextCursor).not.toContain("gptsessionbridge/web/second-example");

    const secondPage = requireVirtual(
      catalog.prepare({ cursor: firstPage.nextCursor, limit: 1 }),
    ).page;
    expect(secondPage.data.map((model) => model.id)).toEqual([
      "gptsessionbridge/web/second-example",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

interface CatalogOverrides {
  readonly now?: () => number;
  readonly virtualModels?: readonly VirtualModelDefinition[];
}

function createCatalog(overrides: CatalogOverrides = {}): VirtualModelCatalog {
  let sequence = 0;
  return new VirtualModelCatalog({
    cursorStore: {
      maxEntries: 4,
      now: overrides.now ?? (() => 1_000),
      random: () => `catalog_entropy_${String((sequence += 1)).padStart(16, "0")}`,
      ttlMs: 1_000,
    },
    ...(overrides.virtualModels === undefined ? {} : { virtualModels: overrides.virtualModels }),
  });
}

function nativeModel(id: string, isDefault: boolean): NativeModelEntry {
  return Object.freeze({
    defaultReasoningEffort: "medium",
    description: `${id} description`,
    displayName: id,
    hidden: false,
    id,
    inputModalities: ["text", "image"],
    isDefault,
    model: id,
    nativeMetadata: Object.freeze({ marker: "LOSSLESS_NATIVE_CANARY" }),
    supportedReasoningEfforts: [
      Object.freeze({ description: "Balanced", reasoningEffort: "medium" }),
    ],
    supportsPersonality: true,
  });
}

function requireNative(prepared: PreparedModelList): NativeModelListContext {
  if (prepared.kind !== "forward-native") {
    throw new Error("Expected a native model-list request.");
  }
  return prepared.context;
}

function requireVirtual(prepared: PreparedModelList): ReturnVirtualModelList {
  if (prepared.kind !== "return-virtual") {
    throw new Error("Expected a virtual model-list response.");
  }
  return prepared;
}
