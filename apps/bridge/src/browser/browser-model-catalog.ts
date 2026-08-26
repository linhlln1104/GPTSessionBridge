import { createHash } from "node:crypto";

import { WEB_MODEL_PUBLIC_PREFIX } from "@gpt-session-bridge/core";
import type { VirtualModelDefinition } from "@gpt-session-bridge/core/catalog";
import type { VirtualModelRouteDefinition } from "@gpt-session-bridge/core/routing";

import {
  createBrowserModelRouteToken,
  isBrowserModelRouteToken,
  type BrowserModelRoute,
} from "./browser-model-route.js";
import type { BrowserCapabilitySnapshot } from "./browser-session-coordinator.js";

const PUBLIC_SLUG_CHARACTERS = 32;
const PUBLIC_HASH_CHARACTERS = 24;

export interface BrowserModelSnapshotSource {
  readonly snapshot: BrowserCapabilitySnapshot | undefined;
}

interface PublishedBrowserModel {
  readonly definition: VirtualModelDefinition;
  readonly route: ResolvedBrowserModelRoute;
  readonly routeDefinition: VirtualModelRouteDefinition;
}

export interface ResolvedBrowserModelRoute extends BrowserModelRoute {
  readonly defaultReasoningEffort: string;
}

/**
 * Projects the coordinator's current, validated capability snapshot into the
 * public Codex catalog. Provider route tokens remain process-local plumbing and
 * are never included in model/list entries.
 */
export class BrowserModelCatalogState {
  readonly #source: BrowserModelSnapshotSource;

  public constructor(source: BrowserModelSnapshotSource) {
    this.#source = source;
  }

  public listVirtualModels(): readonly VirtualModelDefinition[] {
    return Object.freeze(this.#readPublished().map((model) => model.definition));
  }

  public listRouteDefinitions(): readonly VirtualModelRouteDefinition[] {
    return Object.freeze(this.#readPublished().map((model) => model.routeDefinition));
  }

  public resolveModelRoute(value: string): ResolvedBrowserModelRoute | undefined {
    if (!isBrowserModelRouteToken(value)) {
      return undefined;
    }
    for (const model of this.#readPublished()) {
      if (model.routeDefinition.providerModel === value) {
        return model.route;
      }
    }
    return undefined;
  }

  #readPublished(): readonly PublishedBrowserModel[] {
    const snapshot = this.#source.snapshot;
    if (
      !snapshot?.capabilities.modelDiscovery ||
      !snapshot.capabilities.streaming ||
      !snapshot.capabilities.cancellation
    ) {
      return Object.freeze([]);
    }

    const published: PublishedBrowserModel[] = [];
    const publicModels = new Set<string>();
    const routeTokens = new Set<string>();
    for (const model of snapshot.capabilities.models) {
      const route = Object.freeze({
        catalogRevision: snapshot.capabilities.catalogRevision,
        defaultReasoningEffort: model.defaultReasoningEffort,
        modelId: model.id,
        sessionGeneration: snapshot.generation,
        sessionId: snapshot.sessionId,
      });
      const publicModel = createPublicModelKey(route);
      const providerModel = createBrowserModelRouteToken(route);
      if (publicModels.has(publicModel) || routeTokens.has(providerModel)) {
        throw new Error("browser_model_catalog_collision");
      }
      publicModels.add(publicModel);
      routeTokens.add(providerModel);

      const supportedReasoningEfforts = Object.freeze(
        model.supportedReasoningEfforts.map((option) =>
          Object.freeze({
            description: option.description,
            reasoningEffort: option.reasoningEffort,
          }),
        ),
      );
      const definition = Object.freeze({
        defaultReasoningEffort: model.defaultReasoningEffort,
        description: "ChatGPT Web model discovered in the explicitly selected tab.",
        displayName: truncateDisplayName(`Web · ${model.displayName}`),
        publicKey: publicModel,
        supportedReasoningEfforts,
      });
      const routeDefinition = Object.freeze({
        catalogRevision: snapshot.capabilities.catalogRevision,
        defaultReasoningEffort: model.defaultReasoningEffort,
        providerModel,
        publicModel,
        supportedReasoningEfforts: Object.freeze(
          supportedReasoningEfforts.map((option) => option.reasoningEffort),
        ),
      });
      published.push(Object.freeze({ definition, route, routeDefinition }));
    }
    return Object.freeze(published);
  }
}

function createPublicModelKey(route: BrowserModelRoute): string {
  const slug = route.modelId
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, PUBLIC_SLUG_CHARACTERS)
    .replace(/-+$/u, "");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        route.sessionId,
        route.sessionGeneration,
        route.catalogRevision,
        route.modelId,
      ]),
      "utf8",
    )
    .digest("hex");
  return `${WEB_MODEL_PUBLIC_PREFIX}${slug.length > 0 ? slug : "model"}-${digest.slice(0, PUBLIC_HASH_CHARACTERS)}`;
}

function truncateDisplayName(value: string): string {
  return value.length <= 128 ? value : value.slice(0, 128).trimEnd();
}
