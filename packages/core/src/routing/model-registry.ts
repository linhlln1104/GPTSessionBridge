import { isCanonicalWebModelReference } from "../model-namespace.js";
import { THREAD_ROUTING_ERROR_CODE, routingError } from "./errors.js";

export interface VirtualModelRouteDefinition {
  readonly catalogRevision: string;
  readonly defaultReasoningEffort: string;
  readonly providerModel: string;
  readonly publicModel: string;
  readonly supportedReasoningEfforts: readonly string[];
}

const DEFAULT_MAX_VIRTUAL_MODELS = 256;

/** Registry lookups use canonical public identifiers inside the reserved bridge namespace. */
export class ExactVirtualModelRegistry {
  readonly #models: ReadonlyMap<string, VirtualModelRouteDefinition>;

  constructor(
    definitions: readonly VirtualModelRouteDefinition[],
    maxEntries = DEFAULT_MAX_VIRTUAL_MODELS,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || definitions.length > maxEntries) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
    }

    const models = new Map<string, VirtualModelRouteDefinition>();
    for (const definition of definitions) {
      const normalized = Object.freeze({
        catalogRevision: readIdentifier(definition.catalogRevision),
        defaultReasoningEffort: readIdentifier(definition.defaultReasoningEffort),
        providerModel: readIdentifier(definition.providerModel),
        publicModel: readIdentifier(definition.publicModel),
        supportedReasoningEfforts: readReasoningEfforts(definition.supportedReasoningEfforts),
      });

      if (!normalized.supportedReasoningEfforts.includes(normalized.defaultReasoningEffort)) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
      }
      if (
        !isCanonicalWebModelReference(normalized.publicModel) ||
        normalized.providerModel !== normalized.publicModel
      ) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
      }

      if (models.has(normalized.publicModel)) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
      }
      models.set(normalized.publicModel, normalized);
    }

    this.#models = models;
  }

  get size(): number {
    return this.#models.size;
  }

  get(publicModel: string): VirtualModelRouteDefinition | undefined {
    return this.#models.get(publicModel);
  }
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
