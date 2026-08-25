import { randomBytes } from "node:crypto";

import {
  SYNTHETIC_WEB_CATALOG_REVISION,
  VirtualModelCatalog,
} from "@gpt-session-bridge/core/catalog";
import { ThreadRouter } from "@gpt-session-bridge/core/routing";
import type { CapabilityToken } from "@gpt-session-bridge/core/security";

export interface DefaultFacadeState {
  readonly catalog: VirtualModelCatalog;
  readonly threadRouter: ThreadRouter;
}

export function createDefaultFacadeState(
  baseUrl: string,
  capabilityToken: CapabilityToken,
): DefaultFacadeState {
  const catalog = new VirtualModelCatalog({
    cursorStore: {
      maxEntries: 32,
      now: Date.now,
      random: () => randomBytes(24).toString("base64url"),
      ttlMs: 300_000,
    },
  });
  const threadRouter = new ThreadRouter({
    baseUrl,
    capabilityToken,
    models: catalog.listVirtualModels().map((model) => ({
      catalogRevision: SYNTHETIC_WEB_CATALOG_REVISION,
      defaultReasoningEffort: model.defaultReasoningEffort,
      providerModel: model.model,
      publicModel: model.id,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        (option) => option.reasoningEffort,
      ),
    })),
  });

  return Object.freeze({ catalog, threadRouter });
}
