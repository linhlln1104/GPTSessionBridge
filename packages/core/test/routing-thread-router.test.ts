import { describe, expect, it } from "vitest";

import {
  ExactVirtualModelRegistry,
  THREAD_ROUTING_ERROR_CODE,
  ThreadRouter,
  ThreadRoutingError,
  WEB_MODEL_PROVIDER_ID,
  serializeDirectionalRequestId,
  type ThreadRoutingErrorCode,
  type ThreadRoutingOptions,
  type VirtualModelRouteDefinition,
} from "../src/routing/index.js";
import { parseCapabilityToken } from "../src/security/index.js";

const WEB_MODEL: VirtualModelRouteDefinition = Object.freeze({
  catalogRevision: "catalog-revision-1",
  defaultReasoningEffort: "medium",
  providerModel: "gptsessionbridge/web/example-model",
  publicModel: "gptsessionbridge/web/example-model",
  supportedReasoningEfforts: Object.freeze(["low", "medium", "high"]),
});

const SECOND_WEB_MODEL: VirtualModelRouteDefinition = Object.freeze({
  catalogRevision: "catalog-revision-1",
  defaultReasoningEffort: "low",
  providerModel: "gptsessionbridge/web/second-model",
  publicModel: "gptsessionbridge/web/second-model",
  supportedReasoningEfforts: Object.freeze(["low", "medium"]),
});

const PROVIDER_PREFIX = `model_providers.${WEB_MODEL_PROVIDER_ID}`;
const TEST_CAPABILITY_TOKEN = parseCapabilityToken(`gsb_${"A".repeat(43)}`);

function createRouter(overrides: Partial<ThreadRoutingOptions> = {}): ThreadRouter {
  return new ThreadRouter({
    baseUrl: "http://127.0.0.1:43123/v1",
    capabilityToken: TEST_CAPABILITY_TOKEN,
    models: [WEB_MODEL, SECOND_WEB_MODEL],
    ...overrides,
  });
}

function settleSuccess(
  router: ThreadRouter,
  id: number | string,
  threadId: string,
  requestDirection: "client-to-server" | "server-to-client" = "client-to-server",
  result: Readonly<Record<string, unknown>> = webLifecycleResult(threadId),
) {
  return router.settleThreadLifecycle({
    requestDirection,
    response: { id, result },
  });
}

function webLifecycleResult(
  threadId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    model: WEB_MODEL.providerModel,
    modelProvider: WEB_MODEL_PROVIDER_ID,
    reasoningEffort: WEB_MODEL.defaultReasoningEffort,
    thread: { id: threadId, modelProvider: WEB_MODEL_PROVIDER_ID },
    ...overrides,
  };
}

function nativeLifecycleResult(threadId: string): Readonly<Record<string, unknown>> {
  return {
    model: "native-model",
    modelProvider: "native-provider",
    reasoningEffort: "high",
    thread: { id: threadId, modelProvider: "native-provider" },
  };
}

function webForkLifecycleResult(
  childThreadId: string,
  sourceThreadId: string,
): Readonly<Record<string, unknown>> {
  return webLifecycleResult(childThreadId, {
    thread: {
      forkedFromId: sourceThreadId,
      id: childThreadId,
      modelProvider: WEB_MODEL_PROVIDER_ID,
    },
  });
}

function nativeForkLifecycleResult(
  childThreadId: string,
  sourceThreadId: string,
): Readonly<Record<string, unknown>> {
  return {
    ...nativeLifecycleResult(childThreadId),
    thread: {
      forkedFromId: sourceThreadId,
      id: childThreadId,
      modelProvider: "native-provider",
    },
  };
}

function pinWebThread(router: ThreadRouter, threadId = "thread-web"): void {
  router.prepareThreadLifecycle({
    direction: "client-to-server",
    id: "start-web",
    method: "thread/start",
    params: { effort: "medium", model: WEB_MODEL.publicModel },
  });
  expect(settleSuccess(router, "start-web", threadId).status).toBe("committed");
}

function pinNativeThread(router: ThreadRouter, threadId = "thread-native"): void {
  router.prepareThreadLifecycle({
    catalogRevision: "native-revision",
    direction: "client-to-server",
    id: "start-native",
    method: "thread/start",
    params: { effort: "high", model: "native-model" },
  });
  expect(
    settleSuccess(
      router,
      "start-native",
      threadId,
      "client-to-server",
      nativeLifecycleResult(threadId),
    ).status,
  ).toBe("committed");
}

function expectRoutingError(action: () => unknown, code: ThreadRoutingErrorCode): void {
  try {
    action();
    throw new Error("Expected ThreadRoutingError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadRoutingError);
    expect((error as ThreadRoutingError).code).toBe(code);
  }
}

describe("exact virtual model registry", () => {
  it("matches public model identifiers exactly", () => {
    const registry = new ExactVirtualModelRegistry([WEB_MODEL]);

    expect(registry.get("gptsessionbridge/web/example-model")).toEqual(WEB_MODEL);
    expect(registry.get("Web/example-model")).toBeUndefined();
    expect(registry.get("gptsessionbridge/web/example-model ")).toBeUndefined();
  });

  it("rejects duplicate and malformed definitions", () => {
    expectRoutingError(
      () => new ExactVirtualModelRegistry([WEB_MODEL, WEB_MODEL]),
      THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION,
    );
    expectRoutingError(
      () => new ExactVirtualModelRegistry([{ ...WEB_MODEL, catalogRevision: "" }]),
      THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION,
    );
    expectRoutingError(
      () =>
        new ExactVirtualModelRegistry([{ ...WEB_MODEL, publicModel: "web/non-canonical-model" }]),
      THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION,
    );
    expectRoutingError(
      () =>
        new ExactVirtualModelRegistry([{ ...WEB_MODEL, providerModel: "private-provider-model" }]),
      THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION,
    );
  });
});

describe("Web provider injection", () => {
  it("clones Web parameters and injects an in-memory provider capability", () => {
    const router = createRouter();
    const params = {
      allowProviderModelFallback: true,
      config: {
        feature_flag: true,
      },
      cwd: "C:/workspace/example",
      metadata: { nested: ["preserved", 7, true] },
      model: WEB_MODEL.publicModel,
    };
    const originalSnapshot = structuredClone(params);

    const prepared = router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: 1,
      method: "thread/start",
      params,
    });
    const rewritten = prepared.params as Record<string, unknown>;
    const config = rewritten["config"] as Record<string, unknown>;

    expect(prepared.route).toBe("web");
    expect(params).toEqual(originalSnapshot);
    expect(rewritten).not.toBe(params);
    expect(rewritten["metadata"]).toEqual(params.metadata);
    expect(rewritten["metadata"]).not.toBe(params.metadata);
    expect(rewritten).toMatchObject({
      allowProviderModelFallback: false,
      model: WEB_MODEL.providerModel,
      modelProvider: WEB_MODEL_PROVIDER_ID,
    });
    expect(config).toMatchObject({
      "features.respect_system_proxy": false,
      feature_flag: true,
      model: WEB_MODEL.providerModel,
      model_provider: WEB_MODEL_PROVIDER_ID,
      model_reasoning_effort: "medium",
      [`${PROVIDER_PREFIX}.base_url`]: "http://127.0.0.1:43123/v1",
      [`${PROVIDER_PREFIX}.experimental_bearer_token`]: TEST_CAPABILITY_TOKEN,
      [`${PROVIDER_PREFIX}.name`]: "GPTSessionBridge Web",
      [`${PROVIDER_PREFIX}.request_max_retries`]: 0,
      [`${PROVIDER_PREFIX}.requires_openai_auth`]: false,
      [`${PROVIDER_PREFIX}.stream_max_retries`]: 0,
      [`${PROVIDER_PREFIX}.wire_api`]: "responses",
    });
  });

  it("rejects request-local provider definitions and conflicting provider selection", () => {
    const router = createRouter();
    for (const config of [
      { [`${PROVIDER_PREFIX}.base_url`]: "http://127.0.0.1:49999/v1" },
      {
        model_providers: {
          [WEB_MODEL_PROVIDER_ID]: { experimental_bearer_token: "TOKEN_CANARY" },
        },
      },
      { model_providers: { unrelated: { base_url: "http://127.0.0.1:45000/v1" } } },
      { features: { respect_system_proxy: true } },
    ]) {
      expectRoutingError(
        () =>
          router.prepareThreadLifecycle({
            direction: "client-to-server",
            id: JSON.stringify(config),
            method: "thread/start",
            params: { config, model: WEB_MODEL.publicModel },
          }),
        THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
      );
    }

    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "conflicting-provider",
          method: "thread/start",
          params: {
            config: { model_provider: "untrusted-provider" },
            model: WEB_MODEL.publicModel,
          },
        }),
      THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH,
    );
  });

  it("keeps native requests byte-semantically unchanged", () => {
    const router = createRouter();
    const params = {
      config: { model_provider: "openai", untouched: [1, 2, 3] },
      model: "native-model",
    };

    const prepared = router.prepareThreadLifecycle({
      catalogRevision: "native-catalog",
      direction: "client-to-server",
      id: 2,
      method: "thread/start",
      params,
    });

    expect(prepared.route).toBe("native");
    expect(prepared.params).toBe(params);
  });

  it("preserves unrelated request-local custom provider definitions", () => {
    const router = createRouter();
    const params = {
      config: {
        model_provider: "custom-provider",
        model_providers: {
          "custom-provider": {
            base_url: "http://127.0.0.1:45000/v1",
            env_key: "CUSTOM_PROVIDER_TOKEN",
          },
        },
      },
      model: "custom-model",
      modelProvider: "custom-provider",
    };

    const prepared = router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "custom-provider",
      method: "thread/start",
      params,
    });

    expect(prepared.route).toBe("native");
    expect(prepared.params).toBe(params);
  });

  it("rejects non-loopback or ambiguous provider endpoints", () => {
    for (const baseUrl of [
      "https://127.0.0.1:43123/v1",
      "http://localhost:43123/v1",
      "http://0.0.0.0:43123/v1",
      "http://127.0.0.1:43123/other",
      "http://user:secret@127.0.0.1:43123/v1",
    ]) {
      expectRoutingError(
        () => createRouter({ baseUrl }),
        THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION,
      );
    }
  });

  it("rejects non-data Web configuration without storing a pending route", () => {
    const router = createRouter();

    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "invalid-config",
          method: "thread/start",
          params: { config: "invalid", model: WEB_MODEL.publicModel },
        }),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
    expect(router.pendingCount).toBe(0);
  });
});

describe("thread route settlement", () => {
  it("commits a fully pinned route only after a successful response", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: 10,
      method: "thread/start",
      params: {
        config: { model_reasoning_effort: "low" },
        model: WEB_MODEL.publicModel,
      },
    });

    expect(router.getThreadRoute("thread-1")).toBeUndefined();
    const settlement = settleSuccess(
      router,
      10,
      "thread-1",
      "client-to-server",
      webLifecycleResult("thread-1", { reasoningEffort: "low" }),
    );

    expect(settlement).toEqual({
      route: {
        catalogRevision: WEB_MODEL.catalogRevision,
        kind: "web",
        model: WEB_MODEL.publicModel,
        modelProvider: WEB_MODEL_PROVIDER_ID,
        providerModel: WEB_MODEL.providerModel,
        reasoningEffort: "low",
      },
      status: "committed",
    });
    expect(router.getThreadRoute("thread-1")).toEqual((settlement as { route: unknown }).route);
    expect(router.pendingCount).toBe(0);
  });

  it("does not commit failed, malformed, or unknown responses", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "failed",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });
    expect(
      router.settleThreadLifecycle({
        requestDirection: "client-to-server",
        response: { error: { code: -32602, message: "synthetic" }, id: "failed" },
      }),
    ).toEqual({ route: "web", status: "failed" });

    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "malformed",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });
    expect(
      router.settleThreadLifecycle({
        requestDirection: "client-to-server",
        response: { id: "malformed", result: {} },
      }),
    ).toEqual({ route: "web", status: "invalid-result" });
    expect(
      router.settleThreadLifecycle({
        requestDirection: "client-to-server",
        response: { id: "unknown", result: { thread: { id: "not-committed" } } },
      }),
    ).toEqual({ status: "unknown" });
    expect(router.threadCount).toBe(0);
  });

  it.each([
    ["model", webLifecycleResult("thread-invalid", { model: "different-model" })],
    ["provider", webLifecycleResult("thread-invalid", { modelProvider: "native-provider" })],
    ["effort", webLifecycleResult("thread-invalid", { reasoningEffort: "high" })],
    [
      "thread provider",
      webLifecycleResult("thread-invalid", {
        thread: { id: "thread-invalid", modelProvider: "native-provider" },
      }),
    ],
  ])("rejects a Web lifecycle response with mismatched %s", (_field, result) => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: _field,
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });

    expect(settleSuccess(router, _field, "thread-invalid", "client-to-server", result)).toEqual({
      route: "web",
      status: "invalid-result",
    });
    expect(router.getThreadRoute("thread-invalid")).toBeUndefined();
    expect(router.blockedThreadCount).toBe(1);
  });

  it("tombstones a thread returned with an invalid lifecycle identity", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "invalid-start",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });
    expect(
      settleSuccess(
        router,
        "invalid-start",
        "thread-blocked",
        "client-to-server",
        webLifecycleResult("thread-blocked", { modelProvider: "native-provider" }),
      ),
    ).toEqual({ route: "web", status: "invalid-result" });

    for (const action of [
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { input: [], threadId: "thread-blocked" },
        }),
      () => router.validateReviewStart({ threadId: "thread-blocked" }),
      () => router.validateRealtimeStart({ threadId: "thread-blocked" }),
      () => router.validateThreadIdentity({ threadId: "thread-blocked" }),
      () => router.validateThreadIdentity({ conversationId: "thread-blocked" }),
      () => router.validateThreadIdentity({ beforeThreadId: "thread-blocked" }),
      () => router.validateThreadIdentity({ parentThreadId: "thread-blocked" }),
      () => router.validateThreadIdentity({ threads: ["thread-blocked"] }),
      () => router.validateThreadIdentity({ threads: [{ id: "thread-blocked" }] }),
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "blocked-resume",
          method: "thread/resume",
          params: { threadId: "thread-blocked" },
        }),
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "blocked-fork",
          method: "thread/fork",
          params: { threadId: "thread-blocked" },
        }),
    ]) {
      expectRoutingError(action, THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_BLOCKED);
    }
  });

  it("rejects a native decision when the response reports the reserved Web provider", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "restart-provider-check",
      method: "thread/resume",
      params: { threadId: "untracked-thread" },
    });

    expect(
      settleSuccess(
        router,
        "restart-provider-check",
        "untracked-thread",
        "client-to-server",
        webLifecycleResult("untracked-thread"),
      ),
    ).toEqual({ route: "native", status: "invalid-result" });
  });

  it("requires an untracked native resume to return the requested thread", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "untracked-resume",
      method: "thread/resume",
      params: { threadId: "thread-requested" },
    });

    expect(
      settleSuccess(
        router,
        "untracked-resume",
        "thread-returned",
        "client-to-server",
        nativeLifecycleResult("thread-returned"),
      ),
    ).toEqual({ route: "native", status: "invalid-result" });
    expect(router.getThreadRoute("thread-requested")).toBeUndefined();
    expect(router.getThreadRoute("thread-returned")).toBeUndefined();
    expect(router.blockedThreadCount).toBe(1);
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "blocked-returned-thread",
          method: "thread/resume",
          params: { threadId: "thread-returned" },
        }),
      THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_BLOCKED,
    );
  });

  it.each(["thread/resume", "thread/fork"] as const)(
    "requires a source thread identifier for %s",
    (method) => {
      const router = createRouter();
      expectRoutingError(
        () =>
          router.prepareThreadLifecycle({
            direction: "client-to-server",
            id: method,
            method,
            params: {},
          }),
        THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
      );
      expect(router.pendingCount).toBe(0);
    },
  );

  it("rejects a native decision when the response reports a reserved Web model", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "reserved-model-check",
      method: "thread/start",
      params: { model: "native-model" },
    });
    const result = {
      ...nativeLifecycleResult("thread-reserved-model"),
      model: WEB_MODEL.publicModel,
    };

    expect(
      settleSuccess(
        router,
        "reserved-model-check",
        "thread-reserved-model",
        "client-to-server",
        result,
      ),
    ).toEqual({ route: "native", status: "invalid-result" });
    expect(router.blockedThreadCount).toBe(1);
  });

  it("isolates colliding IDs by request direction", () => {
    const router = createRouter();
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: 7,
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });
    router.prepareThreadLifecycle({
      direction: "server-to-client",
      id: 7,
      method: "thread/start",
      params: { model: "native-model" },
    });

    expect(router.pendingCount).toBe(2);
    expect(settleSuccess(router, 7, "thread-client", "client-to-server").status).toBe("committed");
    expect(router.pendingCount).toBe(1);
    expect(
      settleSuccess(
        router,
        7,
        "thread-server",
        "server-to-client",
        nativeLifecycleResult("thread-server"),
      ).status,
    ).toBe("committed");
    expect(router.getThreadRoute("thread-client")?.kind).toBe("web");
    expect(router.getThreadRoute("thread-server")?.kind).toBe("native");
  });

  it("uses unambiguous serialization for string and numeric IDs", () => {
    expect(serializeDirectionalRequestId("client-to-server", 1)).not.toBe(
      serializeDirectionalRequestId("client-to-server", "1"),
    );
    expect(serializeDirectionalRequestId("client-to-server", "1:a")).not.toBe(
      serializeDirectionalRequestId("server-to-client", "1:a"),
    );
    expectRoutingError(
      () => serializeDirectionalRequestId("client-to-server", 1.5),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
    expectRoutingError(
      () => serializeDirectionalRequestId("client-to-server", Number.MAX_SAFE_INTEGER + 1),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
  });

  it("rejects a successful start response that reuses a tracked thread", () => {
    const router = createRouter();
    pinWebThread(router, "shared-thread");
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "native-collision",
      method: "thread/start",
      params: { model: "native-model" },
    });

    expect(
      settleSuccess(
        router,
        "native-collision",
        "shared-thread",
        "client-to-server",
        nativeLifecycleResult("shared-thread"),
      ),
    ).toEqual({ route: "native", status: "invalid-result" });
    expect(router.getThreadRoute("shared-thread")?.kind).toBe("web");
    expect(router.blockedThreadCount).toBe(1);
  });
});

describe("thread-bound selection invariants", () => {
  it("routes lifecycle model overrides from config without allowing ambiguity", () => {
    const router = createRouter();
    const configOnly = router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "config-only",
      method: "thread/start",
      params: { config: { model: WEB_MODEL.publicModel } },
    });
    expect(configOnly.route).toBe("web");
    expect(configOnly.params).toMatchObject({
      config: { model: WEB_MODEL.providerModel },
      model: WEB_MODEL.providerModel,
      modelProvider: WEB_MODEL_PROVIDER_ID,
    });
    router.discardPending("client-to-server", "config-only");

    expect(
      router.prepareThreadLifecycle({
        direction: "client-to-server",
        id: "matching-models",
        method: "thread/start",
        params: { config: { model: WEB_MODEL.publicModel }, model: WEB_MODEL.publicModel },
      }).route,
    ).toBe("web");
    router.discardPending("client-to-server", "matching-models");

    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "conflicting-models",
          method: "thread/start",
          params: { config: { model: "native-model" }, model: WEB_MODEL.publicModel },
        }),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "stale-config-model",
          method: "thread/start",
          params: { config: { model: "gptsessionbridge/web/removed-model" } },
        }),
      THREAD_ROUTING_ERROR_CODE.WEB_MODEL_UNAVAILABLE,
    );
  });

  it.each([
    "gptsessionbridge/web/removed-model",
    "GPTSessionBridge/Web/example-model",
    " gptsessionbridge/web/example-model",
  ])("fails closed for an unavailable reserved model reference %s", (model) => {
    const router = createRouter();
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: model,
          method: "thread/start",
          params: { model },
        }),
      THREAD_ROUTING_ERROR_CODE.WEB_MODEL_UNAVAILABLE,
    );
    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { model, threadId: "untracked-thread" },
        }),
      THREAD_ROUTING_ERROR_CODE.WEB_MODEL_UNAVAILABLE,
    );
  });

  it("inherits the immutable Web route across resume and fork", () => {
    const router = createRouter();
    pinWebThread(router);

    const resume = router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "resume",
      method: "thread/resume",
      params: { personality: "friendly", threadId: "thread-web" },
    });
    expect(resume.params).toMatchObject({
      config: { model_reasoning_effort: "medium" },
      model: WEB_MODEL.providerModel,
      modelProvider: WEB_MODEL_PROVIDER_ID,
      personality: "friendly",
      threadId: "thread-web",
    });
    expect(settleSuccess(router, "resume", "thread-web").status).toBe("committed");

    const fork = router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "fork",
      method: "thread/fork",
      params: {
        allowProviderModelFallback: true,
        lastTurnId: "turn-synthetic",
        threadId: "thread-web",
      },
    });
    expect(fork.params).toMatchObject({
      allowProviderModelFallback: false,
      config: { model_reasoning_effort: "medium" },
      model: WEB_MODEL.providerModel,
      modelProvider: WEB_MODEL_PROVIDER_ID,
    });
    expect(
      settleSuccess(
        router,
        "fork",
        "thread-fork",
        "client-to-server",
        webForkLifecycleResult("thread-fork", "thread-web"),
      ).status,
    ).toBe("committed");
    expect(router.getThreadRoute("thread-fork")).toEqual(router.getThreadRoute("thread-web"));
  });

  it("quarantines a resume source until its lifecycle response settles", () => {
    const router = createRouter();
    pinWebThread(router);
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "pending-resume",
      method: "thread/resume",
      params: { threadId: "thread-web" },
    });

    expect(router.provisionalThreadCount).toBe(1);
    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { input: [], threadId: "thread-web" },
        }),
      THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_PENDING,
    );
    expectRoutingError(() => {
      router.validateServerRequest();
    }, THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_PENDING);
    expect(router.discardPending("client-to-server", "pending-resume")).toBe(true);
    expect(router.provisionalThreadCount).toBe(0);
    expect(() => {
      router.validateServerRequest();
    }).not.toThrow();
  });

  it("accepts validated forks and rejects unverified Web child threads", () => {
    const router = createRouter();
    pinWebThread(router);

    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "fork-for-relation",
      method: "thread/fork",
      params: { threadId: "thread-web" },
    });
    expect(
      settleSuccess(
        router,
        "fork-for-relation",
        "thread-fork",
        "client-to-server",
        webForkLifecycleResult("thread-fork", "thread-web"),
      ).status,
    ).toBe("committed");
    expect(
      router.validateThreadRelation({
        childThreadId: "thread-fork",
        modelProvider: WEB_MODEL_PROVIDER_ID,
        parentThreadId: "thread-web",
      }),
    ).toBe(true);

    expectRoutingError(
      () =>
        router.validateThreadRelation({
          childThreadId: "thread-unverified-child",
          modelProvider: WEB_MODEL_PROVIDER_ID,
          parentThreadId: "thread-web",
        }),
      THREAD_ROUTING_ERROR_CODE.WEB_DERIVED_THREAD_UNSUPPORTED,
    );
  });

  it.each([
    {
      expectedRoute: "web" as const,
      pin: pinWebThread,
      result: webForkLifecycleResult("thread-child", "thread-unrelated"),
      sourceThreadId: "thread-web",
    },
    {
      expectedRoute: "native" as const,
      pin: pinNativeThread,
      result: nativeForkLifecycleResult("thread-child", "thread-unrelated"),
      sourceThreadId: "thread-native",
    },
  ])(
    "rejects a $expectedRoute fork whose ancestry does not match its source",
    ({ expectedRoute, pin, result, sourceThreadId }) => {
      const router = createRouter();
      pin(router);
      router.prepareThreadLifecycle({
        direction: "client-to-server",
        id: `fork-${expectedRoute}`,
        method: "thread/fork",
        params: { threadId: sourceThreadId },
      });

      expect(
        settleSuccess(router, `fork-${expectedRoute}`, "thread-child", "client-to-server", result),
      ).toEqual({ route: expectedRoute, status: "invalid-result" });
      expect(router.getThreadRoute("thread-child")).toBeUndefined();
      expect(router.blockedThreadCount).toBe(1);
    },
  );

  it.each([
    {
      expectedRoute: "web" as const,
      pin: pinWebThread,
      result: webForkLifecycleResult("thread-web", "thread-web"),
      sourceThreadId: "thread-web",
    },
    {
      expectedRoute: "native" as const,
      pin: pinNativeThread,
      result: nativeForkLifecycleResult("thread-native", "thread-native"),
      sourceThreadId: "thread-native",
    },
  ])(
    "rejects a $expectedRoute fork that reuses its source identifier",
    ({ expectedRoute, pin, result, sourceThreadId }) => {
      const router = createRouter();
      pin(router);
      router.prepareThreadLifecycle({
        direction: "client-to-server",
        id: `fork-same-${expectedRoute}`,
        method: "thread/fork",
        params: { threadId: sourceThreadId },
      });

      expect(
        settleSuccess(
          router,
          `fork-same-${expectedRoute}`,
          sourceThreadId,
          "client-to-server",
          result,
        ),
      ).toEqual({ route: expectedRoute, status: "invalid-result" });
      expect(router.blockedThreadCount).toBe(1);
    },
  );

  it("rejects reviews for Web threads in this release", () => {
    const router = createRouter();
    pinWebThread(router);

    const inline = {
      delivery: "inline",
      target: { type: "uncommittedChanges" },
      threadId: "thread-web",
    };
    for (const delivery of ["inline", "detached"]) {
      expectRoutingError(
        () => router.validateReviewStart({ ...inline, delivery }),
        THREAD_ROUTING_ERROR_CODE.WEB_REVIEW_UNSUPPORTED,
      );
    }
  });

  it("rejects unsupported Web operations while allowing cancellation", () => {
    const router = createRouter();
    pinWebThread(router);

    expectRoutingError(
      () => router.validateUnsupportedWebOperation({ threadId: "thread-web" }),
      THREAD_ROUTING_ERROR_CODE.WEB_METHOD_UNSUPPORTED,
    );
    expect(router.validateThreadIdentity({ threadId: "thread-web" })).toEqual({
      threadId: "thread-web",
    });
    expect(router.validateUnsupportedWebOperation({ threadId: "thread-untracked" })).toEqual({
      threadId: "thread-untracked",
    });
  });

  it("rejects Codex-to-Web and Web-to-Codex provider switches", () => {
    const router = createRouter();
    pinNativeThread(router);
    pinWebThread(router);

    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { model: WEB_MODEL.publicModel, threadId: "thread-native" },
        }),
      THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH,
    );
    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "thread/settings/update",
          params: { model: "native-model", threadId: "thread-web" },
        }),
      THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH,
    );
  });

  it("pins collaboration-mode model settings for Web threads", () => {
    const router = createRouter();
    pinWebThread(router);

    for (const method of ["turn/start", "thread/settings/update"] as const) {
      const rewritten = router.validateThreadBound({
        method,
        params: {
          collaborationMode: {
            mode: "plan",
            settings: {
              developer_instructions: null,
              model: WEB_MODEL.publicModel,
              reasoning_effort: "medium",
            },
          },
          threadId: "thread-web",
        },
      }) as Record<string, unknown>;
      expect(rewritten).toMatchObject({
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: WEB_MODEL.providerModel,
            reasoning_effort: "medium",
          },
        },
        model: WEB_MODEL.providerModel,
      });
    }

    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: {
            collaborationMode: {
              mode: "plan",
              settings: { model: SECOND_WEB_MODEL.publicModel, reasoning_effort: "medium" },
            },
            threadId: "thread-web",
          },
        }),
      THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH,
    );
  });

  it("rejects unsupported realtime sessions for Web threads", () => {
    const router = createRouter();
    pinWebThread(router);
    pinNativeThread(router);

    expectRoutingError(
      () => router.validateRealtimeStart({ threadId: "thread-web" }),
      THREAD_ROUTING_ERROR_CODE.WEB_REALTIME_UNSUPPORTED,
    );
    const native = { model: "native-realtime-model", threadId: "thread-native" };
    expect(router.validateRealtimeStart(native)).toBe(native);
  });

  it("rejects Web model, effort, and catalog-selection changes", () => {
    const router = createRouter();
    pinWebThread(router);

    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { model: SECOND_WEB_MODEL.publicModel, threadId: "thread-web" },
        }),
      THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH,
    );
    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "thread/settings/update",
          params: { effort: "high", threadId: "thread-web" },
        }),
      THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH,
    );
  });

  it("rewrites the exact pinned Web selection and preserves native updates", () => {
    const router = createRouter();
    pinWebThread(router);
    pinNativeThread(router);

    const webParams = {
      input: [{ text: "synthetic request", type: "text" }],
      model: WEB_MODEL.publicModel,
      threadId: "thread-web",
    };
    const rewritten = router.validateThreadBound({
      method: "turn/start",
      params: webParams,
    }) as Record<string, unknown>;
    expect(rewritten).not.toBe(webParams);
    expect(rewritten).toMatchObject({
      effort: "medium",
      model: WEB_MODEL.providerModel,
      threadId: "thread-web",
    });

    const nativeParams = {
      effort: "medium",
      model: "another-native-model",
      threadId: "thread-native",
    };
    expect(
      router.validateThreadBound({ method: "thread/settings/update", params: nativeParams }),
    ).toBe(nativeParams);
  });

  it("fails closed when a Web model targets an untracked thread", () => {
    const router = createRouter();
    expectRoutingError(
      () =>
        router.validateThreadBound({
          method: "turn/start",
          params: { model: WEB_MODEL.publicModel, threadId: "unknown-thread" },
        }),
      THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN,
    );
  });

  it("fails closed when an untracked thread is resumed or forked as Web", () => {
    const router = createRouter();
    for (const method of ["thread/resume", "thread/fork"] as const) {
      expectRoutingError(
        () =>
          router.prepareThreadLifecycle({
            direction: "client-to-server",
            id: method,
            method,
            params: { model: WEB_MODEL.publicModel, threadId: "unknown-thread" },
          }),
        THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN,
      );
    }
  });

  it("fails closed for resume identities that can override threadId", () => {
    const router = createRouter();
    pinWebThread(router);

    for (const identity of [{ history: [] }, { path: "synthetic-rollout.jsonl" }]) {
      expectRoutingError(
        () =>
          router.prepareThreadLifecycle({
            direction: "client-to-server",
            id: JSON.stringify(identity),
            method: "thread/resume",
            params: { ...identity, threadId: "thread-web" },
          }),
        THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
      );
    }

    for (const [method, path] of [
      ["thread/resume", ""],
      ["thread/fork", ""],
      ["thread/fork", "synthetic-rollout.jsonl"],
    ] as const) {
      expectRoutingError(
        () =>
          router.prepareThreadLifecycle({
            direction: "client-to-server",
            id: `${method}:${path}`,
            method,
            params: { path, threadId: "thread-web" },
          }),
        THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
      );
    }
  });

  it("rejects unsupported Web reasoning and reserved provider impersonation", () => {
    const router = createRouter();
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "unsupported-effort",
          method: "thread/start",
          params: { effort: "unsupported", model: WEB_MODEL.publicModel },
        }),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "reserved-provider",
          method: "thread/start",
          params: { model: "native-model", modelProvider: WEB_MODEL_PROVIDER_ID },
        }),
      THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS,
    );
  });
});

describe("bounded routing state", () => {
  it("bounds pending requests and rejects duplicate directional IDs", () => {
    const router = createRouter({ maxPendingRequests: 1 });
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "pending",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });

    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "second",
          method: "thread/start",
          params: { model: WEB_MODEL.publicModel },
        }),
      THREAD_ROUTING_ERROR_CODE.PENDING_CAPACITY,
    );
    expect(router.discardPending("client-to-server", "pending")).toBe(true);

    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "duplicate",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });
    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "duplicate",
          method: "thread/start",
          params: { model: WEB_MODEL.publicModel },
        }),
      THREAD_ROUTING_ERROR_CODE.REQUEST_ID_CONFLICT,
    );
    expect(router.clearPending()).toBe(1);
  });

  it("reserves bounded thread slots before forwarding starts", () => {
    const router = createRouter({ maxThreadRoutes: 1 });
    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "reserved",
      method: "thread/start",
      params: { model: WEB_MODEL.publicModel },
    });

    expectRoutingError(
      () =>
        router.prepareThreadLifecycle({
          direction: "client-to-server",
          id: "over-capacity",
          method: "thread/start",
          params: { model: "native-model" },
        }),
      THREAD_ROUTING_ERROR_CODE.THREAD_CAPACITY,
    );
    expect(router.discardPending("client-to-server", "reserved")).toBe(true);

    router.prepareThreadLifecycle({
      direction: "client-to-server",
      id: "committed",
      method: "thread/start",
      params: { model: "native-model" },
    });
    expect(
      settleSuccess(
        router,
        "committed",
        "thread-only",
        "client-to-server",
        nativeLifecycleResult("thread-only"),
      ).status,
    ).toBe("committed");
    expect(router.forgetThread("thread-only")).toBe(true);
    expect(router.threadCount).toBe(0);
  });
});
