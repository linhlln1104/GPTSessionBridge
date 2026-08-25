import { ModelCatalogError } from "./errors.js";
import { isReservedWebModelReference } from "../model-namespace.js";
import { OpaqueCursorStore, type OpaqueCursorStoreOptions } from "./opaque-cursor-store.js";
import {
  createVirtualModelEntry,
  SYNTHETIC_WEB_MODEL_DEFINITION,
  type VirtualModelDefinition,
  type VirtualModelEntry,
} from "./virtual-model.js";

export interface ModelIdentity {
  readonly id: string;
  readonly isDefault: boolean;
  readonly model: string;
}

export interface NativeModelEntry extends ModelIdentity, Readonly<Record<string, unknown>> {}

export type CatalogModelEntry = NativeModelEntry | VirtualModelEntry;

export interface ModelListPage<T extends ModelIdentity = CatalogModelEntry> extends Readonly<
  Record<string, unknown>
> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface ModelListRequest {
  readonly cursor?: string | null;
  readonly includeHidden?: boolean;
  readonly limit?: number;
}

interface NativeContinuationState {
  readonly complete: boolean;
  readonly includeHidden: boolean;
  readonly ids: readonly string[];
  readonly models: readonly string[];
  readonly nativeCursor: string;
}

interface VirtualCursorState {
  readonly includeHidden: boolean;
  readonly models: readonly VirtualModelEntry[];
}

type CatalogCursorState =
  | ({ readonly kind: "native" } & NativeContinuationState)
  | ({ readonly kind: "virtual" } & VirtualCursorState);

export interface NativeModelListContext {
  readonly completeCollisionCoverage: boolean;
  readonly includeHidden: boolean;
  readonly limit: number;
  readonly nativeCursor: string | null;
  readonly observedIds: readonly string[];
  readonly observedModels: readonly string[];
}

export interface ForwardNativeModelList {
  readonly kind: "forward-native";
  readonly context: NativeModelListContext;
  readonly upstreamCursor: string | null;
}

export interface ReturnVirtualModelList {
  readonly kind: "return-virtual";
  readonly page: ModelListPage<VirtualModelEntry>;
}

export type PreparedModelList = ForwardNativeModelList | ReturnVirtualModelList;

export interface VirtualModelCatalogOptions {
  readonly cursorStore: OpaqueCursorStoreOptions;
  readonly defaultLimit?: number;
  readonly virtualModels?: readonly VirtualModelDefinition[];
}

const MAX_CATALOG_CURSOR_LENGTH = 4_096;
const MAX_MODEL_IDENTIFIER_LENGTH = 512;
const MAX_NATIVE_MODELS_PER_PAGE = 4_096;
const MAX_OBSERVED_NATIVE_MODELS = 4_096;
const MAX_MODEL_LIST_LIMIT = 4_294_967_295;

/**
 * Adds public Web routes after the official model catalog has been exhausted.
 */
export class VirtualModelCatalog {
  readonly #cursorStore: OpaqueCursorStore<CatalogCursorState>;
  readonly #defaultLimit: number;
  readonly #virtualModels: readonly VirtualModelEntry[];

  public constructor(options: VirtualModelCatalogOptions) {
    this.#defaultLimit = normalizeLimit(options.defaultLimit ?? 100);
    if (
      options.cursorStore.maxEntries <= 0 ||
      !Number.isSafeInteger(options.cursorStore.maxEntries)
    ) {
      throw new ModelCatalogError(
        "invalid_configuration",
        "maxEntries must be a positive safe integer.",
      );
    }
    if (options.cursorStore.ttlMs <= 0 || !Number.isSafeInteger(options.cursorStore.ttlMs)) {
      throw new ModelCatalogError(
        "invalid_configuration",
        "ttlMs must be a positive safe integer.",
      );
    }

    this.#cursorStore = new OpaqueCursorStore<CatalogCursorState>(options.cursorStore);

    const definitions = options.virtualModels ?? [SYNTHETIC_WEB_MODEL_DEFINITION];
    this.#virtualModels = Object.freeze(definitions.map(createVirtualModelEntry));
    assertUniqueVirtualModels(this.#virtualModels);
  }

  public prepare(request: ModelListRequest): PreparedModelList {
    const limit = normalizeLimit(request.limit ?? this.#defaultLimit);
    const cursor = normalizeCursor(request.cursor);
    const includeHidden = request.includeHidden ?? false;

    if (cursor !== null && this.#cursorStore.owns(cursor)) {
      const state = this.#cursorStore.read(cursor);
      if (state.includeHidden !== includeHidden) {
        throw new ModelCatalogError(
          "invalid_cursor",
          "The model catalog cursor does not match the requested filters.",
        );
      }
      if (state.kind === "virtual") {
        return Object.freeze({
          kind: "return-virtual" as const,
          page: this.#paginateVirtualModels(state.models, limit, includeHidden),
        });
      }
      return Object.freeze({
        kind: "forward-native" as const,
        context: Object.freeze({
          completeCollisionCoverage: state.complete,
          includeHidden,
          limit,
          nativeCursor: state.nativeCursor,
          observedIds: state.ids,
          observedModels: state.models,
        }),
        upstreamCursor: state.nativeCursor,
      });
    }

    return Object.freeze({
      kind: "forward-native" as const,
      context: Object.freeze({
        completeCollisionCoverage: cursor === null,
        includeHidden,
        limit,
        nativeCursor: cursor,
        observedIds: Object.freeze([]),
        observedModels: Object.freeze([]),
      }),
      upstreamCursor: cursor,
    });
  }

  public mergeNativePage(context: NativeModelListContext, nativePage: unknown): ModelListPage {
    const normalizedPage = normalizeNativePage(nativePage);

    const ids = new Set(context.observedIds);
    const models = new Set(context.observedModels);
    for (const entry of normalizedPage.data) {
      ids.add(entry.id);
      models.add(entry.model);
    }
    if (ids.size > MAX_OBSERVED_NATIVE_MODELS || models.size > MAX_OBSERVED_NATIVE_MODELS) {
      throw new ModelCatalogError(
        "invalid_model_page",
        "The native model catalog exceeds the bridge collision-checking capacity.",
      );
    }
    assertNoNativeCollision(ids, models, this.#virtualModels);

    if (normalizedPage.nextCursor !== null) {
      const nextCursor = this.#cursorStore.create({
        complete: context.completeCollisionCoverage,
        ids: Object.freeze([...ids]),
        includeHidden: context.includeHidden,
        kind: "native",
        models: Object.freeze([...models]),
        nativeCursor: normalizedPage.nextCursor,
      });
      return Object.freeze({
        ...normalizedPage,
        nextCursor,
      });
    }

    if (!context.completeCollisionCoverage || this.#virtualModels.length === 0) {
      return normalizedPage;
    }

    const availableSlots = Math.max(0, context.limit - normalizedPage.data.length);
    const appended = this.#virtualModels.slice(0, availableSlots);
    const remaining = this.#virtualModels.slice(appended.length);
    const nextCursor =
      remaining.length === 0
        ? null
        : this.#cursorStore.create({
            includeHidden: context.includeHidden,
            kind: "virtual",
            models: Object.freeze(remaining),
          });

    return Object.freeze({
      ...normalizedPage,
      data: Object.freeze([...normalizedPage.data, ...appended]),
      nextCursor,
    });
  }

  public hasPublicKey(publicKey: string): boolean {
    return this.#virtualModels.some((model) => model.id === publicKey);
  }

  public listVirtualModels(): readonly VirtualModelEntry[] {
    return this.#virtualModels;
  }

  #paginateVirtualModels(
    models: readonly VirtualModelEntry[],
    limit: number,
    includeHidden: boolean,
  ): ModelListPage<VirtualModelEntry> {
    const data = models.slice(0, limit);
    const remaining = models.slice(data.length);
    const nextCursor =
      remaining.length === 0
        ? null
        : this.#cursorStore.create({
            includeHidden,
            kind: "virtual",
            models: Object.freeze(remaining),
          });

    return Object.freeze({
      data: Object.freeze(data),
      nextCursor,
    });
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_MODEL_LIST_LIMIT) {
    throw new ModelCatalogError("invalid_limit", "The model list limit must be nonnegative.");
  }
  return Math.max(1, limit);
}

function normalizeCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (cursor.length === 0 || cursor.length > MAX_CATALOG_CURSOR_LENGTH) {
    throw new ModelCatalogError("invalid_cursor", "The model catalog cursor is invalid.");
  }
  return cursor;
}

function normalizeNativePage(page: unknown): ModelListPage<NativeModelEntry> {
  if (!isDataRecord(page)) {
    throw new ModelCatalogError("invalid_model_page", "The native model page is invalid.");
  }

  const data = page["data"];
  const nextCursor = page["nextCursor"];
  if (
    !Array.isArray(data) ||
    data.length > MAX_NATIVE_MODELS_PER_PAGE ||
    (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string")
  ) {
    throw new ModelCatalogError("invalid_model_page", "The native model page is invalid.");
  }
  if (
    typeof nextCursor === "string" &&
    (nextCursor.length === 0 || nextCursor.length > MAX_CATALOG_CURSOR_LENGTH)
  ) {
    throw new ModelCatalogError("invalid_model_page", "The native model cursor is invalid.");
  }

  for (const value of data as readonly unknown[]) {
    if (
      !isDataRecord(value) ||
      typeof value["id"] !== "string" ||
      value["id"].length === 0 ||
      value["id"].length > MAX_MODEL_IDENTIFIER_LENGTH ||
      typeof value["model"] !== "string" ||
      value["model"].length === 0 ||
      value["model"].length > MAX_MODEL_IDENTIFIER_LENGTH ||
      typeof value["isDefault"] !== "boolean"
    ) {
      throw new ModelCatalogError("invalid_model_page", "A native model entry is invalid.");
    }
  }

  if (nextCursor !== undefined) {
    return page as unknown as ModelListPage<NativeModelEntry>;
  }
  return Object.freeze({ ...page, data: data as readonly NativeModelEntry[], nextCursor: null });
}

function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUniqueVirtualModels(models: readonly VirtualModelEntry[]): void {
  const ids = new Set<string>();
  const modelKeys = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id) || modelKeys.has(model.model)) {
      throw new ModelCatalogError("model_collision", "Virtual model public keys must be unique.");
    }
    ids.add(model.id);
    modelKeys.add(model.model);
  }
}

function assertNoNativeCollision(
  ids: ReadonlySet<string>,
  models: ReadonlySet<string>,
  virtualModels: readonly VirtualModelEntry[],
): void {
  for (const virtualModel of virtualModels) {
    if (ids.has(virtualModel.id) || models.has(virtualModel.model)) {
      throw new ModelCatalogError(
        "model_collision",
        "A virtual model public key collides with the native model catalog.",
      );
    }
  }
  for (const id of ids) {
    if (isReservedWebModelReference(id)) {
      throw new ModelCatalogError(
        "model_collision",
        "The native model catalog uses the reserved Web model namespace.",
      );
    }
  }
  for (const model of models) {
    if (isReservedWebModelReference(model)) {
      throw new ModelCatalogError(
        "model_collision",
        "The native model catalog uses the reserved Web model namespace.",
      );
    }
  }
}
