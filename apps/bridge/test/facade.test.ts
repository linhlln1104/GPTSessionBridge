import { PassThrough } from "node:stream";

import { WEB_MODEL_PROVIDER_ID } from "@gpt-session-bridge/core/routing";
import { parseCapabilityToken } from "@gpt-session-bridge/core/security";
import {
  appServerEnvelopeSchema,
  type AppServerEnvelope,
  type JsonObject,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it, vi } from "vitest";

import { AppServerRouter, type AppServerDispatch } from "../src/facade/app-server-router.js";
import { BidirectionalAppServerProxy } from "../src/facade/bidirectional-proxy.js";
import { createDefaultFacadeState } from "../src/facade/default-state.js";

const BASE_URL = "http://127.0.0.1:43123/v1";
const WEB_MODEL = "gptsessionbridge/web/example-model";
const TEST_CAPABILITY_TOKEN = parseCapabilityToken(`gsb_${"A".repeat(43)}`);

function createRouter(onInitializeComplete?: () => void): AppServerRouter {
  const state = createDefaultFacadeState(BASE_URL, TEST_CAPABILITY_TOKEN);
  return new AppServerRouter({
    ...state,
    ...(onInitializeComplete === undefined ? {} : { onInitializeComplete }),
  });
}

function webThreadResult(threadId: string): JsonObject {
  return {
    model: WEB_MODEL,
    modelProvider: WEB_MODEL_PROVIDER_ID,
    reasoningEffort: "medium",
    thread: { id: threadId, modelProvider: WEB_MODEL_PROVIDER_ID },
  };
}

describe("AppServerRouter model catalog", () => {
  it("preserves native models and appends the synthetic Web model on the final page", () => {
    const router = createRouter();
    const request = {
      id: 1,
      method: "model/list",
      params: { cursor: null, includeHidden: true, limit: 100 },
    } as const;

    expect(router.handleClient(request)).toEqual({ envelope: request, kind: "forward" });
    const nativeModel = {
      displayName: "Native Model",
      hidden: false,
      id: "native-model",
      isDefault: true,
      model: "native-model",
    };
    const response = router.handleServer({
      id: 1,
      result: { data: [nativeModel], nextCursor: null, upstreamField: "preserved" },
    });
    const result = readResult(response);
    const data = result["data"] as Record<string, unknown>[];

    expect(data[0]).toEqual(nativeModel);
    expect(data[1]).toMatchObject({
      displayName: "Web · Example Model",
      hidden: false,
      id: WEB_MODEL,
      inputModalities: ["text"],
      isDefault: false,
      model: WEB_MODEL,
    });
    expect(result["nextCursor"]).toBeNull();
    expect(result["upstreamField"]).toBe("preserved");
  });

  it("serves overflow Web models from an opaque bridge cursor", () => {
    const router = createRouter();
    router.handleClient({ id: "native", method: "model/list", params: { limit: 1 } });
    const nativePage = readResult(
      router.handleServer({
        id: "native",
        result: {
          data: [{ id: "native-model", isDefault: true, model: "native-model" }],
          nextCursor: null,
        },
      }),
    );
    const cursor = nativePage["nextCursor"];

    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") {
      throw new TypeError("Expected an opaque cursor");
    }
    expect(cursor).not.toContain(WEB_MODEL);
    const virtualPage = router.handleClient({
      id: "virtual",
      method: "model/list",
      params: { cursor, limit: 1 },
    });
    expect(virtualPage.kind).toBe("reply");
    expect(readResult(virtualPage)["data"]).toEqual([
      expect.objectContaining({ id: WEB_MODEL, isDefault: false }),
    ]);
  });

  it("unwraps native cursors and binds them to the original hidden-model filter", () => {
    const router = createRouter();
    router.handleClient({
      id: "first",
      method: "model/list",
      params: { includeHidden: false, limit: 1 },
    });
    const firstPage = readResult(
      router.handleServer({
        id: "first",
        result: {
          data: [{ id: "native-one", isDefault: true, model: "native-one" }],
          nextCursor: "1",
        },
      }),
    );
    const cursor = firstPage["nextCursor"];
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") {
      throw new TypeError("Expected an opaque native continuation cursor");
    }
    expect(cursor).not.toBe("1");

    const toggled = router.handleClient({
      id: "toggled",
      method: "model/list",
      params: { cursor, includeHidden: true, limit: 1 },
    });
    expect(readError(toggled)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "invalid_cursor" },
    });

    const continuation = router.handleClient({
      id: "second",
      method: "model/list",
      params: { cursor, includeHidden: false, limit: 1 },
    });
    expect(readParams(continuation)).toMatchObject({
      cursor: "1",
      includeHidden: false,
      limit: 1,
    });
  });

  it("returns stable errors for malformed owned payloads", () => {
    const malformedRequest = createRouter().handleClient({
      id: 4,
      method: "model/list",
      params: { cursor: 7 },
    });
    expect(readError(malformedRequest)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "catalog.invalid_cursor" },
    });

    const router = createRouter();
    router.handleClient({ id: 5, method: "model/list" });
    const malformedResponse = router.handleServer({ id: 5, result: { data: "invalid" } });
    expect(readError(malformedResponse)).toMatchObject({ code: -32603 });
  });

  it("rejects duplicate outstanding client IDs without stealing the first response", () => {
    const router = createRouter();
    router.handleClient({ id: "shared", method: "model/list" });

    const duplicate = router.handleClient({ id: "shared", method: "unknown/request" });
    expect(readError(duplicate)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "routing.request_id_conflict" },
    });

    const original = readResult(
      router.handleServer({
        id: "shared",
        result: {
          data: [{ id: "native-model", isDefault: true, model: "native-model" }],
        },
      }),
    );
    expect(original["data"]).toEqual([
      expect.objectContaining({ id: "native-model" }),
      expect.objectContaining({ id: WEB_MODEL }),
    ]);
  });
});

describe("AppServerRouter thread routing", () => {
  it("injects the local provider, pins the thread, and rejects provider switches", () => {
    const router = createRouter();
    const start = router.handleClient({
      id: "start",
      method: "thread/start",
      params: {
        allowProviderModelFallback: true,
        config: { unrelated: true },
        model: WEB_MODEL,
      },
    });
    const startParams = readParams(start);
    const config = startParams["config"] as Record<string, unknown>;
    const providerPrefix = `model_providers.${WEB_MODEL_PROVIDER_ID}`;

    expect(startParams).toMatchObject({
      allowProviderModelFallback: false,
      model: WEB_MODEL,
      modelProvider: WEB_MODEL_PROVIDER_ID,
    });
    expect(config).toMatchObject({
      model_provider: WEB_MODEL_PROVIDER_ID,
      model_reasoning_effort: "medium",
      unrelated: true,
      [`${providerPrefix}.base_url`]: BASE_URL,
      [`${providerPrefix}.experimental_bearer_token`]: TEST_CAPABILITY_TOKEN,
      [`${providerPrefix}.request_max_retries`]: 0,
      [`${providerPrefix}.stream_max_retries`]: 0,
      [`${providerPrefix}.wire_api`]: "responses",
    });
    expect(
      router.handleServer({
        id: "start",
        result: webThreadResult("thread-web"),
      }).kind,
    ).toBe("forward");
    const turn = router.handleClient({
      id: "turn",
      method: "turn/start",
      params: { input: [{ text: "synthetic", type: "input_text" }], threadId: "thread-web" },
    });
    expect(readParams(turn)).toMatchObject({ effort: "medium", model: WEB_MODEL });

    const switched = router.handleClient({
      id: "switch",
      method: "turn/start",
      params: { input: [], model: "native-model", threadId: "thread-web" },
    });
    expect(readError(switched)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "routing.provider_switch" },
    });
  });

  it("forwards unknown traffic and isolates child requests with colliding IDs", () => {
    const router = createRouter();
    const client = { id: 9, method: "unknown/client", params: { value: true } } as const;
    const server = { id: 9, method: "unknown/server", params: { value: false } } as const;

    expect(router.handleClient(client)).toEqual({ envelope: client, kind: "forward" });
    expect(router.handleServer(server)).toEqual({ envelope: server, kind: "forward" });
    expect(router.handleClient({ id: 9, result: { accepted: true } })).toEqual({
      envelope: { id: 9, result: { accepted: true } },
      kind: "forward",
    });
  });

  it("applies routing guards to client notifications", () => {
    const router = createRouter();
    const initialized = { method: "initialized" } as const;
    const cancellation = { method: "$/cancelRequest", params: { id: "native-request" } } as const;
    expect(router.handleClient(initialized)).toEqual({ envelope: initialized, kind: "forward" });
    expect(router.handleClient(cancellation)).toEqual({
      envelope: cancellation,
      kind: "forward",
    });
    expect(router.handleClient({ method: "thread/start", params: { model: WEB_MODEL } })).toEqual({
      kind: "drop",
    });

    router.handleClient({ id: "start", method: "thread/start", params: { model: WEB_MODEL } });
    router.handleServer({ id: "start", result: webThreadResult("thread-web") });

    const turn = router.handleClient({
      method: "turn/start",
      params: { input: [], threadId: "thread-web" },
    });
    expect(turn.kind).toBe("forward");
    expect(readParams(turn)).toMatchObject({
      effort: "medium",
      model: WEB_MODEL,
      threadId: "thread-web",
    });
    expect(
      router.handleClient({
        id: "pending-resume",
        method: "thread/resume",
        params: { threadId: "thread-web" },
      }).kind,
    ).toBe("forward");
    expect(
      router.handleClient({
        method: "turn/start",
        params: { input: [], threadId: "thread-web" },
      }),
    ).toEqual({ kind: "drop" });
    expect(router.handleClient(cancellation)).toEqual({
      envelope: cancellation,
      kind: "forward",
    });
    expect(
      router.handleServer({
        error: { code: -32602, message: "cancelled" },
        id: "pending-resume",
      }).kind,
    ).toBe("forward");
    expect(
      router.handleClient({
        method: "turn/steer",
        params: { input: [], threadId: "thread-web" },
      }),
    ).toEqual({ kind: "drop" });
    expect(
      router.handleClient({
        method: "config/value/write",
        params: {
          keyPath: "model_provider",
          mergeStrategy: "replace",
          value: WEB_MODEL_PROVIDER_ID,
        },
      }),
    ).toEqual({ kind: "drop" });
  });

  it.each([
    ["config/value/write", { keyPath: "model", mergeStrategy: "replace", value: WEB_MODEL }],
    [
      "config/value/write",
      {
        keyPath: "model_provider",
        mergeStrategy: "replace",
        value: WEB_MODEL_PROVIDER_ID,
      },
    ],
    [
      "config/value/write",
      {
        keyPath: `model_providers.${WEB_MODEL_PROVIDER_ID}.base_url`,
        mergeStrategy: "upsert",
        value: "http://127.0.0.1:9/v1",
      },
    ],
    [
      "config/value/write",
      {
        keyPath: '"model_providers"."gptsessionbridge\\_web".base_url',
        mergeStrategy: "replace",
        value: "http://127.0.0.1:9/v1",
      },
    ],
    [
      "config/batchWrite",
      {
        edits: [
          {
            keyPath: "model_providers",
            mergeStrategy: "upsert",
            value: { [WEB_MODEL_PROVIDER_ID]: { base_url: "http://127.0.0.1:9/v1" } },
          },
        ],
      },
    ],
    [
      "config/batchWrite",
      {
        edits: [
          { keyPath: "features.safe", mergeStrategy: "upsert", value: true },
          {
            keyPath: '"model_providers"."gptsessionbridge\\_web".base_url',
            mergeStrategy: "replace",
            value: "http://127.0.0.1:9/v1",
          },
        ],
      },
    ],
  ])("rejects reserved configuration through %s", (method, params) => {
    const dispatch = createRouter().handleClient({ id: method, method, params });
    expect(readError(dispatch)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "routing.reserved_configuration" },
    });
  });

  it("tombstones a thread after an invalid upstream lifecycle result", () => {
    const router = createRouter();
    router.handleClient({
      id: "invalid-start",
      method: "thread/start",
      params: { model: WEB_MODEL },
    });
    const invalidResult = {
      ...webThreadResult("thread-blocked"),
      modelProvider: "native-provider",
    };
    expect(() => router.handleServer({ id: "invalid-start", result: invalidResult })).toThrow(
      expect.objectContaining({ code: "routing.invalid_upstream_result" }),
    );

    const blockedRequests: readonly (readonly [string, JsonObject])[] = [
      ["turn/start", { input: [], threadId: "thread-blocked" }],
      ["thread/settings/update", { threadId: "thread-blocked" }],
      ["review/start", { threadId: "thread-blocked" }],
      ["thread/realtime/start", { threadId: "thread-blocked" }],
      ["turn/interrupt", { threadId: "thread-blocked" }],
      ["thread/resume", { threadId: "thread-blocked" }],
      ["thread/fork", { threadId: "thread-blocked" }],
    ];
    for (const [method, params] of blockedRequests) {
      const dispatch = router.handleClient({ id: `blocked:${method}`, method, params });
      expect(readError(dispatch)).toMatchObject({
        code: -32602,
        data: { bridgeCode: "routing.thread_route_blocked" },
      });
    }
    expect(
      router.handleClient({
        method: "turn/interrupt",
        params: { threadId: "thread-blocked", turnId: "turn-blocked" },
      }),
    ).toEqual({ kind: "drop" });
  });

  it("forwards cancellation but rejects steering for a pinned Web thread", () => {
    const router = createRouter();
    router.handleClient({ id: "start", method: "thread/start", params: { model: WEB_MODEL } });
    router.handleServer({ id: "start", result: webThreadResult("thread-web") });

    const interrupt = {
      id: "interrupt",
      method: "turn/interrupt",
      params: { threadId: "thread-web", turnId: "turn-web" },
    } as const;
    expect(router.handleClient(interrupt)).toEqual({ envelope: interrupt, kind: "forward" });
    expect(
      readError(
        router.handleClient({
          id: "steer",
          method: "turn/steer",
          params: { input: [], threadId: "thread-web" },
        }),
      ),
    ).toMatchObject({ data: { bridgeCode: "routing.web_method_unsupported" } });
  });

  it("quarantines resume traffic until lifecycle identity is validated", () => {
    const router = createRouter();
    router.handleClient({ id: "start", method: "thread/start", params: { model: WEB_MODEL } });
    router.handleServer({ id: "start", result: webThreadResult("thread-web") });
    expect(
      router.handleClient({
        id: "resume",
        method: "thread/resume",
        params: { threadId: "thread-web" },
      }).kind,
    ).toBe("forward");

    const pipelined = router.handleClient({
      id: "pipelined-turn",
      method: "turn/start",
      params: { input: [], threadId: "thread-web" },
    });
    expect(readError(pipelined)).toMatchObject({
      data: { bridgeCode: "routing.thread_route_pending" },
    });
    const serverRequest = router.handleServer({
      id: "approval",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-web" },
    });
    expect(readError(serverRequest)).toMatchObject({
      data: { bridgeCode: "routing.thread_route_pending" },
    });
    expect(router.handleClient({ id: "prior-server-request", result: {} }).kind).toBe("drop");

    expect(router.handleServer({ id: "resume", result: webThreadResult("thread-web") }).kind).toBe(
      "forward",
    );
    expect(
      router.handleClient({
        id: "interrupt-after-resume",
        method: "turn/interrupt",
        params: { threadId: "thread-web", turnId: "turn-web" },
      }).kind,
    ).toBe("forward");
  });

  it("marks initialization complete only after a successful child response", () => {
    const onInitializeComplete = vi.fn();
    const router = createRouter(onInitializeComplete);
    router.handleClient({ id: "init", method: "initialize", params: {} });
    router.handleServer({ error: { code: -32000, message: "synthetic" }, id: "other" });
    expect(onInitializeComplete).not.toHaveBeenCalled();

    router.handleServer({ id: "init", result: { userAgent: "synthetic" } });
    router.handleServer({ id: "init", result: { userAgent: "duplicate" } });
    expect(onInitializeComplete).toHaveBeenCalledOnce();
  });

  it("keeps a Web route pinned when Codex unloads a closed thread", () => {
    const router = createRouter();
    router.handleClient({
      id: "start",
      method: "thread/start",
      params: { model: WEB_MODEL },
    });
    router.handleServer({ id: "start", result: webThreadResult("thread-web") });
    router.handleServer({ method: "thread/closed", params: { threadId: "thread-web" } });

    const resume = router.handleClient({
      id: "resume",
      method: "thread/resume",
      params: { threadId: "thread-web" },
    });
    expect(readParams(resume)).toMatchObject({
      model: WEB_MODEL,
      modelProvider: WEB_MODEL_PROVIDER_ID,
      threadId: "thread-web",
    });
  });

  it("rejects unsupported Web review, realtime, and unverified child flows", () => {
    const router = createRouter();
    router.handleClient({
      id: "start",
      method: "thread/start",
      params: { model: WEB_MODEL },
    });
    router.handleServer({ id: "start", result: webThreadResult("thread-web") });

    for (const delivery of ["inline", "detached"]) {
      const review = router.handleClient({
        id: `review-${delivery}`,
        method: "review/start",
        params: {
          delivery,
          target: { type: "uncommittedChanges" },
          threadId: "thread-web",
        },
      });
      expect(readError(review)).toMatchObject({
        code: -32602,
        data: { bridgeCode: "routing.web_review_unsupported" },
      });
    }
    const realtime = router.handleClient({
      id: "realtime",
      method: "thread/realtime/start",
      params: { threadId: "thread-web" },
    });
    expect(readError(realtime)).toMatchObject({
      code: -32602,
      data: { bridgeCode: "routing.web_realtime_unsupported" },
    });

    const started = {
      method: "thread/started",
      params: {
        thread: {
          id: "thread-child",
          modelProvider: WEB_MODEL_PROVIDER_ID,
          parentThreadId: "thread-web",
        },
      },
    } as const;
    expect(() => router.handleServer(started)).toThrow(
      expect.objectContaining({ code: "routing.web_derived_thread_unsupported" }),
    );
  });
});

describe("BidirectionalAppServerProxy", () => {
  it("proxies fragmented JSONL in both directions and applies catalog routing", async () => {
    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();
    const serverInput = new PassThrough();
    const serverOutput = new PassThrough();
    const proxy = new BidirectionalAppServerProxy({
      clientInput,
      clientOutput,
      maxBufferedBytes: 4_096,
      maxFrameBytes: 2_048,
      maxQueuedMessages: 16,
      router: createRouter(),
      serverInput,
      serverOutput,
    });
    const completion = proxy.run();

    const forwardedPromise = readJsonLine(serverInput);
    clientInput.write('{"id":1,"method":"model/');
    clientInput.write('list","params":{"limit":100}}\n');
    expect(await forwardedPromise).toEqual({
      id: 1,
      method: "model/list",
      params: { limit: 100 },
    });

    const clientResponsePromise = readJsonLine(clientOutput);
    serverOutput.write(
      `${JSON.stringify({
        id: 1,
        result: {
          data: [{ id: "native-model", isDefault: true, model: "native-model" }],
          nextCursor: null,
        },
      })}\n`,
    );
    const response = (await clientResponsePromise) as unknown as {
      result: { data: { id: string }[] };
    };
    expect(response.result.data.map((model) => model.id)).toEqual(["native-model", WEB_MODEL]);

    clientInput.end();
    await expect(completion).resolves.toBe("client-ended");
  });

  it("supports an idempotent pre-run stop and rejects a second run", async () => {
    const harness = createProxyHarness();
    harness.proxy.stop();
    await expect(harness.proxy.run()).resolves.toBe("stopped");
    harness.proxy.stop();
    await expect(harness.proxy.run()).rejects.toMatchObject({ code: "transport_closed" });
  });

  it("closes the facade transport after an invalid lifecycle identity", async () => {
    const clientInput = new PassThrough();
    const serverInput = new PassThrough();
    const serverOutput = new PassThrough();
    const proxy = new BidirectionalAppServerProxy({
      clientInput,
      clientOutput: new PassThrough(),
      maxBufferedBytes: 4_096,
      maxFrameBytes: 2_048,
      maxQueuedMessages: 16,
      router: createRouter(),
      serverInput,
      serverOutput,
    });
    const completion = proxy.run();
    const forwarded = readJsonLine(serverInput);
    clientInput.write(
      `${JSON.stringify({ id: "start", method: "thread/start", params: { model: WEB_MODEL } })}\n`,
    );
    await forwarded;
    serverOutput.write(
      `${JSON.stringify({
        id: "start",
        result: { ...webThreadResult("thread-invalid"), modelProvider: "native-provider" },
      })}\n`,
    );

    await expect(completion).rejects.toMatchObject({ code: "transport_closed" });
  });

  it("ends when the child stream closes and fails closed on malformed client JSONL", async () => {
    const serverEnded = createProxyHarness();
    const serverCompletion = serverEnded.proxy.run();
    serverEnded.serverOutput.end();
    await expect(serverCompletion).resolves.toBe("server-ended");

    const malformed = createProxyHarness();
    const malformedCompletion = malformed.proxy.run();
    malformed.clientInput.write("{invalid-json}\n");
    await expect(malformedCompletion).rejects.toMatchObject({ code: "transport_closed" });
  });
});

function createProxyHarness(): {
  readonly clientInput: PassThrough;
  readonly proxy: BidirectionalAppServerProxy;
  readonly serverOutput: PassThrough;
} {
  const clientInput = new PassThrough();
  const serverOutput = new PassThrough();
  return {
    clientInput,
    proxy: new BidirectionalAppServerProxy({
      clientInput,
      clientOutput: new PassThrough(),
      maxBufferedBytes: 4_096,
      maxFrameBytes: 2_048,
      maxQueuedMessages: 16,
      router: createRouter(),
      serverInput: new PassThrough(),
      serverOutput,
    }),
    serverOutput,
  };
}

function readResult(dispatch: AppServerDispatch): Record<string, unknown> {
  if (dispatch.kind === "drop" || !("result" in dispatch.envelope)) {
    throw new TypeError("Expected result dispatch");
  }
  return dispatch.envelope.result as Record<string, unknown>;
}

function readError(dispatch: AppServerDispatch): Record<string, unknown> {
  if (dispatch.kind === "drop" || !("error" in dispatch.envelope)) {
    throw new TypeError("Expected error dispatch");
  }
  return dispatch.envelope.error as unknown as Record<string, unknown>;
}

function readParams(dispatch: AppServerDispatch): Record<string, unknown> {
  if (dispatch.kind === "drop" || !("params" in dispatch.envelope)) {
    throw new TypeError("Expected request dispatch");
  }
  return dispatch.envelope.params as Record<string, unknown>;
}

function readJsonLine(stream: PassThrough): Promise<AppServerEnvelope> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      cleanup();
      try {
        const parsed: unknown = JSON.parse(buffered.slice(0, newline));
        resolve(appServerEnvelopeSchema.parse(parsed));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid JSON line"));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("error", onError);
  });
}
