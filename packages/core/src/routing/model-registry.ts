import {
  isCanonicalWebModelReference,
  isCanonicalWebProviderModelReference,
} from "../model-namespace.js";
import { THREAD_ROUTING_ERROR_CODE, routingError } from "./errors.js";

export interface VirtualModelRouteDefinition {
  readonly catalogRevision: string;
  readonly defaultReasoningEffort: string;
  readonly providerModel: string;
  readonly publicModel: string;
  readonly supportedReasoningEfforts: readonly string[];
}

export type VirtualModelRouteSource = () => readonly VirtualModelRouteDefinition[];

const DEFAULT_MAX_VIRTUAL_MODELS = 256;
const PROVIDER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

/** Registry lookups use canonical public identifiers inside the reserved bridge namespace. */
export class ExactVirtualModelRegistry {
  readonly #fixedModels: ReadonlyMap<string, VirtualModelRouteDefinition> | undefined;
  readonly #maxEntries: number;
  readonly #source: VirtualModelRouteSource | undefined;

  constructor(
    definitions: readonly VirtualModelRouteDefinition[] | VirtualModelRouteSource,
    maxEntries = DEFAULT_MAX_VIRTUAL_MODELS,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
    }

    this.#maxEntries = maxEntries;
    if (typeof definitions === "function") {
      this.#source = definitions;
      this.#fixedModels = undefined;
      this.#readModels();
    } else {
      this.#source = undefined;
      this.#fixedModels = normalizeDefinitions(definitions, maxEntries);
    }
  }

  get size(): number {
    return this.#readModels().size;
  }

  get(publicModel: string): VirtualModelRouteDefinition | undefined {
    return this.#readModels().get(publicModel);
  }

  #readModels(): ReadonlyMap<string, VirtualModelRouteDefinition> {
    if (this.#fixedModels !== undefined) {
      return this.#fixedModels;
    }
    const definitions = this.#source?.();
    if (!Array.isArray(definitions)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
    }
    return normalizeDefinitions(definitions, this.#maxEntries);
  }
}

function normalizeDefinitions(
  definitions: readonly VirtualModelRouteDefinition[],
  maxEntries: number,
): ReadonlyMap<string, VirtualModelRouteDefinition> {
  if (definitions.length > maxEntries) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }

  const models = new Map<string, VirtualModelRouteDefinition>();
  for (const definition of definitions) {
    const normalized = Object.freeze({
      catalogRevision: readIdentifier(definition.catalogRevision),
      defaultReasoningEffort: readIdentifier(definition.defaultReasoningEffort),
      providerModel: readProviderModel(definition.providerModel),
      publicModel: readIdentifier(definition.publicModel),
      supportedReasoningEfforts: readReasoningEfforts(definition.supportedReasoningEfforts),
    });

    if (
      !normalized.supportedReasoningEfforts.includes(normalized.defaultReasoningEffort) ||
      !isCanonicalWebModelReference(normalized.publicModel) ||
      models.has(normalized.publicModel)
    ) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
    }
    models.set(normalized.publicModel, normalized);
  }

  return models;
}

function readReasoningEfforts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }

  const efforts = value.map(readIdentifier);
  if (new Set(efforts).size !== efforts.length) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }
  return Object.freeze(efforts);
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }
  return value;
}

function readProviderModel(value: unknown): string {
  const model = readIdentifier(value);
  if (!PROVIDER_MODEL_PATTERN.test(model) || !isCanonicalWebProviderModelReference(model)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }
  return model;
}
