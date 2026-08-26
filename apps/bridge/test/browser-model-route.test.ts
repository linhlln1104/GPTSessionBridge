import { describe, expect, it } from "vitest";

import {
  createBrowserModelRouteToken,
  isBrowserModelRouteToken,
} from "../src/browser/browser-model-route.js";

describe("browser model route token", () => {
  it("creates a deterministic bounded token for an exact route", () => {
    const route = {
      catalogRevision: "catalog-revision:42",
      modelId: "chatgpt/web-model-5.6",
      profile: "text-v1" as const,
      sessionGeneration: 7,
      sessionId: "session-a",
    };
    const token = createBrowserModelRouteToken(route);

    expect(token).toBe(createBrowserModelRouteToken(route));
    expect(token.length).toBeLessThan(128);
    expect(isBrowserModelRouteToken(token)).toBe(true);
    expect(
      createBrowserModelRouteToken({ ...route, catalogRevision: "catalog-revision:43" }),
    ).not.toBe(token);
    expect(createBrowserModelRouteToken({ ...route, modelId: "chatgpt/web-model-5.5" })).not.toBe(
      token,
    );
    expect(createBrowserModelRouteToken({ ...route, sessionGeneration: 8 })).not.toBe(token);
    expect(createBrowserModelRouteToken({ ...route, sessionId: "session-b" })).not.toBe(token);
    expect(createBrowserModelRouteToken({ ...route, profile: "agent-v2" })).not.toBe(token);
  });

  it.each([
    undefined,
    "",
    "gptsessionbridge/web/route-v2-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "gptsessionbridge/web/route-v1-short",
    "gptsessionbridge/web/route-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "gptsessionbridge/web/route-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects malformed token %s", (token) => {
    expect(isBrowserModelRouteToken(token)).toBe(false);
  });

  it("rejects values outside the browser protocol schemas", () => {
    expect(() =>
      createBrowserModelRouteToken({
        catalogRevision: "has space",
        modelId: "model",
        profile: "text-v1",
        sessionGeneration: 1,
        sessionId: "session-a",
      }),
    ).toThrow();
    expect(() =>
      createBrowserModelRouteToken({
        catalogRevision: "catalog",
        modelId: "has space",
        profile: "text-v1",
        sessionGeneration: 1,
        sessionId: "session-a",
      }),
    ).toThrow();
    expect(() =>
      createBrowserModelRouteToken({
        catalogRevision: "catalog",
        modelId: "model",
        profile: "text-v1",
        sessionGeneration: 0,
        sessionId: "session-a",
      }),
    ).toThrow();
    expect(() =>
      createBrowserModelRouteToken({
        catalogRevision: "catalog",
        modelId: "model",
        profile: "unknown" as "text-v1",
        sessionGeneration: 1,
        sessionId: "session-a",
      }),
    ).toThrow();
  });
});
