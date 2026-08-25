import { ModelCatalogError } from "./errors.js";
import { isCanonicalWebModelReference } from "../model-namespace.js";

const EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export interface ReasoningEffortOption {
  readonly reasoningEffort: string;
  readonly description: string;
}

export interface VirtualModelDefinition {
  readonly publicKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedReasoningEfforts: readonly ReasoningEffortOption[];
  readonly defaultReasoningEffort: string;
}

export interface VirtualModelEntry {
  readonly additionalSpeedTiers: readonly [];
  readonly availabilityNux: null;
  readonly defaultServiceTier: null;
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: false;
  readonly supportedReasoningEfforts: readonly ReasoningEffortOption[];
  readonly defaultReasoningEffort: string;
  readonly inputModalities: readonly ["text"];
  readonly supportsPersonality: false;
  readonly modelSpecialty: null;
  readonly multiAgentVersion: null;
  readonly serviceTiers: readonly [];
  readonly upgrade: null;
  readonly upgradeInfo: null;
  readonly isDefault: false;
}

export const SYNTHETIC_WEB_CATALOG_REVISION = "synthetic-web-v1" as const;

export const SYNTHETIC_WEB_MODEL_DEFINITION: VirtualModelDefinition = deepFreezeDefinition({
  publicKey: "gptsessionbridge/web/example-model",
  displayName: "Web · Example Model",
  description: "Synthetic Web route for validating the local bridge.",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Light reasoning" },
    { reasoningEffort: "medium", description: "Balanced reasoning" },
    { reasoningEffort: "high", description: "Deeper reasoning" },
  ],
  defaultReasoningEffort: "medium",
});

export function createVirtualModelEntry(definition: VirtualModelDefinition): VirtualModelEntry {
  validateDefinition(definition);

  const supportedReasoningEfforts = definition.supportedReasoningEfforts.map((effort) =>
    Object.freeze({
      description: effort.description,
      reasoningEffort: effort.reasoningEffort,
    }),
  );

  return Object.freeze({
    additionalSpeedTiers: Object.freeze<[]>([]),
    availabilityNux: null,
    defaultReasoningEffort: definition.defaultReasoningEffort,
    defaultServiceTier: null,
    description: definition.description,
    displayName: definition.displayName,
    hidden: false,
    id: definition.publicKey,
    inputModalities: Object.freeze(["text"] as const),
    isDefault: false,
    model: definition.publicKey,
    modelSpecialty: null,
    multiAgentVersion: null,
    serviceTiers: Object.freeze<[]>([]),
    supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
    supportsPersonality: false,
    upgrade: null,
    upgradeInfo: null,
  });
}

function validateDefinition(definition: VirtualModelDefinition): void {
  if (!isCanonicalWebModelReference(definition.publicKey)) {
    throw new ModelCatalogError(
      "invalid_model",
      "A virtual model public key must use the gptsessionbridge/web/<public-key> format.",
    );
  }
  assertText(definition.displayName, "displayName", 1, 128);
  assertText(definition.description, "description", 1, 512);

  if (
    definition.supportedReasoningEfforts.length === 0 ||
    definition.supportedReasoningEfforts.length > 16
  ) {
    throw new ModelCatalogError(
      "invalid_model",
      "A virtual model must expose between 1 and 16 reasoning effort options.",
    );
  }

  const effortIds = new Set<string>();
  for (const effort of definition.supportedReasoningEfforts) {
    if (!EFFORT_ID_PATTERN.test(effort.reasoningEffort)) {
      throw new ModelCatalogError("invalid_model", "A reasoning effort id is invalid.");
    }
    assertText(effort.description, "reasoning effort description", 1, 256);
    if (effortIds.has(effort.reasoningEffort)) {
      throw new ModelCatalogError("invalid_model", "Reasoning effort ids must be unique.");
    }
    effortIds.add(effort.reasoningEffort);
  }

  if (!effortIds.has(definition.defaultReasoningEffort)) {
    throw new ModelCatalogError(
      "invalid_model",
      "The default reasoning effort must be one of the supported options.",
    );
  }
}

function assertText(value: string, name: string, minLength: number, maxLength: number): void {
  if (value.length < minLength || value.length > maxLength || value.trim() !== value) {
    throw new ModelCatalogError(
      "invalid_model",
      `${name} must contain between ${String(minLength)} and ${String(maxLength)} trimmed characters.`,
    );
  }
}

function deepFreezeDefinition(definition: VirtualModelDefinition): VirtualModelDefinition {
  for (const effort of definition.supportedReasoningEfforts) {
    Object.freeze(effort);
  }
  Object.freeze(definition.supportedReasoningEfforts);
  return Object.freeze(definition);
}
