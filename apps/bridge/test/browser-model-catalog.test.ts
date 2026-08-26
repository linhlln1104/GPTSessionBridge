import type { BrowserCapabilities } from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { BrowserModelCatalogState, type BrowserCapabilitySnapshot } from "../src/browser/index.js";

describe("browser model catalog projection", () => {
  it("publishes nothing until an explicitly selected browser catalog is connected", () => {
    const source: { snapshot: BrowserCapabilitySnapshot | undefined } = { snapshot: undefined };
    const state = new BrowserModelCatalogState(source);

    expect(state.listVirtualModels()).toEqual([]);
    expect(state.listRouteDefinitions()).toEqual([]);
    expect(state.resolveModelRoute("native-model")).toBeUndefined();
  });

  it.each([{ cancellation: false }, { modelDiscovery: false }, { streaming: false }])(
    "publishes nothing without required turn capabilities: %o",
    (overrides) => {
      const current = snapshot("catalog-a", "ui-model");
      const source = {
        snapshot: {
          ...current,
          capabilities: { ...current.capabilities, ...overrides },
        },
      };
      const state = new BrowserModelCatalogState(source);

      expect(state.listVirtualModels()).toEqual([]);
      expect(state.listRouteDefinitions()).toEqual([]);
    },
  );

  it("separates public picker identities from exact provider route tokens", () => {
    const source = { snapshot: snapshot("catalog-a", "ui-gpt-5-6-sol-abc") };
    const state = new BrowserModelCatalogState(source);

    const [definition] = state.listVirtualModels();
    const [route] = state.listRouteDefinitions();
    expect(definition).toMatchObject({
      defaultReasoningEffort: "medium",
      displayName: "Web · GPT-5.6 Sol",
      supportedReasoningEfforts: [
        {
          description: "Use the model option shown in ChatGPT Web.",
          reasoningEffort: "medium",
        },
      ],
    });
    expect(definition?.publicKey).toMatch(
      /^gptsessionbridge\/web\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u,
    );
    expect(route).toMatchObject({
      catalogRevision: "catalog-a",
      publicModel: definition?.publicKey,
    });
    expect(route?.providerModel).toMatch(/^gptsessionbridge\/web\/route-v1-[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(definition)).not.toContain("/route-v1-");
    expect(state.resolveModelRoute(route?.providerModel ?? "")).toEqual({
      catalogRevision: "catalog-a",
      defaultReasoningEffort: "medium",
      modelId: "ui-gpt-5-6-sol-abc",
      sessionGeneration: 1,
      sessionId: "session-a",
    });
  });

  it("invalidates both public and provider identities when the catalog changes", () => {
    const source = { snapshot: snapshot("catalog-a", "ui-gpt-5-6-sol-abc") };
    const state = new BrowserModelCatalogState(source);
    const firstDefinition = state.listVirtualModels()[0];
    const firstRoute = state.listRouteDefinitions()[0];

    source.snapshot = snapshot("catalog-b", "ui-gpt-5-6-sol-abc");
    const secondDefinition = state.listVirtualModels()[0];
    const secondRoute = state.listRouteDefinitions()[0];

    expect(secondDefinition?.publicKey).not.toBe(firstDefinition?.publicKey);
    expect(secondRoute?.providerModel).not.toBe(firstRoute?.providerModel);
    expect(state.resolveModelRoute(firstRoute?.providerModel ?? "")).toBeUndefined();
    expect(state.resolveModelRoute(secondRoute?.providerModel ?? "")).toEqual({
      catalogRevision: "catalog-b",
      defaultReasoningEffort: "medium",
      modelId: "ui-gpt-5-6-sol-abc",
      sessionGeneration: 1,
      sessionId: "session-a",
    });
  });

  it("does not revive a route after reconnecting another tab with the same catalog", () => {
    const source = { snapshot: snapshot("catalog-a", "ui-model", "session-a", 1) };
    const state = new BrowserModelCatalogState(source);
    const firstPublicModel = state.listVirtualModels()[0]?.publicKey;
    const firstProviderModel = state.listRouteDefinitions()[0]?.providerModel;

    source.snapshot = snapshot("catalog-a", "ui-model", "session-b", 1);

    expect(state.listVirtualModels()[0]?.publicKey).not.toBe(firstPublicModel);
    expect(state.resolveModelRoute(firstProviderModel ?? "")).toBeUndefined();
    expect(state.listRouteDefinitions()[0]?.providerModel).not.toBe(firstProviderModel);
  });
});

function snapshot(
  catalogRevision: string,
  id: string,
  sessionId = "session-a",
  generation = 1,
): BrowserCapabilitySnapshot {
  const capabilities: BrowserCapabilities = {
    cancellation: true,
    catalogRevision,
    imageInput: false,
    modelDiscovery: true,
    models: [
      {
        defaultReasoningEffort: "medium",
        displayName: "GPT-5.6 Sol",
        id,
        inputModalities: ["text"],
        supportedReasoningEfforts: [
          {
            description: "Use the model option shown in ChatGPT Web.",
            reasoningEffort: "medium",
          },
        ],
      },
    ],
    streaming: true,
    temporaryChat: false,
    toolCalls: false,
  };
  return Object.freeze({ capabilities, generation, sessionId });
}
