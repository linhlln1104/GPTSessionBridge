import { randomBytes } from "node:crypto";

import { VirtualModelCatalog } from "@gpt-session-bridge/core/catalog";
import { ExactVirtualModelRegistry, ThreadRouter } from "@gpt-session-bridge/core/routing";
import type { CapabilityToken } from "@gpt-session-bridge/core/security";

import type { BrowserModelCatalogState } from "../browser/browser-model-catalog.js";

export interface DefaultFacadeState {
  readonly catalog: VirtualModelCatalog;
  readonly threadRouter: ThreadRouter;
}

export function createDefaultFacadeState(
  baseUrl: string,
  capabilityToken: CapabilityToken,
  browserModels: BrowserModelCatalogState,
): DefaultFacadeState {
  const catalog = new VirtualModelCatalog({
    cursorStore: {
      maxEntries: 32,
      now: Date.now,
      random: () => randomBytes(24).toString("base64url"),
      ttlMs: 300_000,
    },
    virtualModelSource: () => browserModels.listVirtualModels(),
  });
  const threadRouter = new ThreadRouter({
    baseUrl,
    capabilityToken,
    models: new ExactVirtualModelRegistry(() => browserModels.listRouteDefinitions(), 128),
  });

  return Object.freeze({ catalog, threadRouter });
}
