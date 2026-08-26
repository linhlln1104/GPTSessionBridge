import { createHash } from "node:crypto";

import {
  catalogRevisionSchema,
  modelIdSchema,
  sessionIdSchema,
} from "@gpt-session-bridge/protocol";

const ROUTE_TOKEN_PREFIX = "gptsessionbridge/web/route-v1-";
const SHA256_BASE64URL_CHARACTERS = 43;
const ROUTE_TOKEN_PATTERN = new RegExp(
  `^gptsessionbridge/web/route-v1-[A-Za-z0-9_-]{${String(SHA256_BASE64URL_CHARACTERS)}}$`,
  "u",
);

export interface BrowserModelTarget {
  readonly catalogRevision: string;
  readonly modelId: string;
}

export interface BrowserModelRoute extends BrowserModelTarget {
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

/**
 * Creates a deterministic opaque lookup key for an exact browser catalog
 * route. The digest is neither a secret nor an authenticator; the Responses
 * server must resolve it against the catalog state that issued it.
 */
export function createBrowserModelRouteToken(route: BrowserModelRoute): string {
  const catalogRevision = catalogRevisionSchema.parse(route.catalogRevision);
  const modelId = modelIdSchema.parse(route.modelId);
  const sessionId = sessionIdSchema.parse(route.sessionId);
  if (!Number.isSafeInteger(route.sessionGeneration) || route.sessionGeneration < 1) {
    throw new TypeError("Invalid browser session generation");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionId, route.sessionGeneration, catalogRevision, modelId]), "utf8")
    .digest("base64url");
  return `${ROUTE_TOKEN_PREFIX}${digest}`;
}

export function isBrowserModelRouteToken(value: unknown): value is string {
  return typeof value === "string" && ROUTE_TOKEN_PATTERN.test(value);
}
