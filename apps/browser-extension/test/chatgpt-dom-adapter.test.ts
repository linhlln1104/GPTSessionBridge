import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ChatGptDomAdapter,
  type AdapterCatalog,
  type ChatGptDomAgentSink,
  type ChatGptDomAdapterSink,
  type ChatGptUiDriver,
  type ChatGptUiTurnPreparation,
  type ChatGptUiTurnObserver,
  type ChatGptUiTurnStartOutcome,
  type ObservedModelOption,
} from "../src/content/chatgpt-dom-adapter.js";
import type {
  PageAgentTurnStartMessage,
  PageTurnStartMessage,
} from "../src/protocol/page-messages.js";

describe("ChatGPT DOM adapter", () => {
  it("derives stable collision-resistant IDs only from the observed semantic catalog", async () => {
    const driver = new FakeUiDriver([
      {
        displayName: "GPT-5.6 Sol",
        selected: true,
        semanticKey: "menu:models|menuitemradio:GPT-5.6 Sol",
      },
      {
        displayName: "o3 Leaving on August 26",
        selected: false,
        semanticKey: "menu:models|menuitemradio:o3 Leaving",
      },
    ]);
    const adapter = new ChatGptDomAdapter({ digest, driver });

    const first = await adapter.discoverCatalog();
    driver.options = [...driver.options].reverse();
    const reordered = await adapter.discoverCatalog();

    expect(first.models.map((model) => model.displayName)).toEqual([
      "GPT-5.6 Sol",
      "o3 Leaving on August 26",
    ]);
    expect(first.models[0]?.id).toMatch(/^ui-gpt-5-6-sol-[a-f0-9]{24}$/u);
    expect(first.models.every((model) => model.id.length <= 64)).toBe(true);
    expect(first.catalogRevision).toBe(reordered.catalogRevision);
    expect(first.models).toEqual(reordered.models);
    expect(first.models[0]).toMatchObject({
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
    });
  });

  it("changes the revision when exact advertised model metadata changes", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const first = await adapter.discoverCatalog();
    driver.options = [modelOption("WEB ALPHA")];

    const changed = await adapter.discoverCatalog();

    expect(changed.models[0]?.id).toBe(first.models[0]?.id);
    expect(changed.models[0]?.displayName).toBe("WEB ALPHA");
    expect(changed.catalogRevision).not.toBe(first.catalogRevision);
  });

  it("publishes a newly observed model catalog after initial discovery", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    await adapter.discoverCatalog();
    let changed: AdapterCatalog | undefined;
    adapter.onCatalogChanged((catalog) => {
      changed = catalog;
    });

    driver.observe([modelOption("Web Alpha"), modelOption("Web Beta", false)]);
    await waitUntil(() => changed !== undefined);

    expect(changed?.models.map((model) => model.displayName)).toEqual(["Web Alpha", "Web Beta"]);
  });

  it("streams one text-only turn and forwards a confirmed cancellation", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const events: string[] = [];
    const sink = createSink(events);
    driver.startBehavior = "stream";

    await adapter.startTurn(turnCommand(catalog, "turn-1"), sink);
    expect(events).toEqual(["started:turn-1", "delta:turn-1:hello"]);
    await adapter.cancelTurn("turn-1");
    expect(events).toEqual(["started:turn-1", "delta:turn-1:hello", "cancelled:turn-1"]);
    expect(driver.selectedSemanticKey).toBe(driver.options[0]?.semanticKey);
    expect(driver.prompt).toBe("first");
  });

  it("returns the complete agent envelope byte-for-byte only at terminal and rejects replay", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const output = ' \tGSB/2 BEGIN\r\n{"value":"a\u00a0b  "}\r\nGSB/2 END \n';
    const completed: string[] = [];
    const events: string[] = [];
    const command = agentTurnCommand(catalog, "turn-agent");
    driver.agentOutput = output;

    await adapter.startAgentTurn(command, createAgentSink(events, completed));

    expect(events).toEqual(["started:turn-agent", "completed:turn-agent"]);
    expect(completed).toEqual([output]);
    expect(new TextEncoder().encode(completed[0])).toEqual(new TextEncoder().encode(output));
    let replayError: unknown;
    try {
      void adapter.startAgentTurn(command, createAgentSink([], []));
    } catch (error) {
      replayError = error;
    }
    expect(replayError).toMatchObject({
      failure: {
        code: "browser_state_changed",
        message: "The one-shot agent turn permit was already consumed.",
        retryable: false,
      },
    });
  });

  it("cancels a submitted turn before its first output delta", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const events: string[] = [];
    driver.startBehavior = "wait";

    await adapter.startTurn(turnCommand(catalog, "turn-1"), createSink(events));
    expect(events).toEqual(["started:turn-1"]);
    await adapter.cancelTurn("turn-1");

    expect(events).toEqual(["started:turn-1", "cancelled:turn-1"]);
  });

  it("honors cancellation during catalog discovery without submitting the prompt", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const gate = deferred();
    const events: string[] = [];
    driver.discoveryGate = gate.promise;

    const starting = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink(events));
    await adapter.cancelTurn("turn-1");
    gate.resolve();
    await starting;

    expect(events).toEqual(["cancelled:turn-1"]);
    expect(driver.prompt).toBeUndefined();
    expect(driver.selectedSemanticKey).toBeUndefined();
  });

  it("honors cancellation while visible model selection is in flight", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const gate = deferred();
    const events: string[] = [];
    driver.selectionGate = gate.promise;

    const starting = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink(events));
    await waitUntil(() => driver.selectionStarted);
    await adapter.cancelTurn("turn-1");
    gate.resolve();
    await starting;

    expect(events).toEqual(["cancelled:turn-1"]);
    expect(driver.prompt).toBeUndefined();
  });

  it("rechecks cancellation immediately before the synchronous submit handoff", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const gate = deferred();
    const events: string[] = [];
    driver.preparationGate = gate.promise;

    const starting = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink(events));
    await waitUntil(() => driver.preparationStarted);
    await adapter.cancelTurn("turn-1");
    gate.resolve();
    await starting;

    expect(events).toEqual(["cancelled:turn-1"]);
    expect(driver.prompt).toBeUndefined();
  });

  it("reserves the active turn before asynchronous discovery", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const gate = deferred();
    driver.discoveryGate = gate.promise;

    const first = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink([]));
    await expect(
      adapter.startTurn(turnCommand(catalog, "turn-2"), createSink([])),
    ).rejects.toMatchObject({
      failure: {
        code: "turn_already_active",
        message: "A ChatGPT Web turn is already active.",
        retryable: false,
      },
    });
    gate.resolve();
    driver.startBehavior = "complete";
    await first;
  });

  it("rejects multiple text items before model discovery or composer access", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const command = turnCommand(catalog, "turn-1");

    await expect(
      adapter.startTurn(
        { ...command, input: [...command.input, { text: "second", type: "text" }] },
        createSink([]),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "unsupported",
        retryable: false,
      },
    });
    expect(driver.prompt).toBeUndefined();
    expect(driver.selectedSemanticKey).toBeUndefined();
  });

  it("does not submit when the catalog changes during model selection", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    driver.optionsAfterSelection = [modelOption("Web Alpha"), modelOption("Web Beta", false)];

    await expect(
      adapter.startTurn(turnCommand(catalog, "turn-1"), createSink([])),
    ).rejects.toMatchObject({
      failure: {
        code: "browser_state_changed",
        message: "ChatGPT Web changed before the text turn was submitted.",
        retryable: true,
      },
    });
    expect(driver.prompt).toBeUndefined();
  });

  it("does not submit if the selected model changes before the confirmation re-read", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha"), modelOption("Web Beta", false)]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    driver.optionsAfterSelection = [modelOption("Web Alpha", false), modelOption("Web Beta")];

    await expect(
      adapter.startTurn(turnCommand(catalog, "turn-1"), createSink([])),
    ).rejects.toMatchObject({
      failure: {
        code: "browser_state_changed",
        retryable: true,
      },
    });
    expect(driver.prompt).toBeUndefined();
  });

  it("revalidates the raw picker after catalog hashing yields to DOM drift", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const gate = deferred();
    let digestCalls = 0;
    const gatedDigest = async (value: string): Promise<string> => {
      digestCalls += 1;
      if (digestCalls === 3) {
        await gate.promise;
      }
      return digest(value);
    };
    const adapter = new ChatGptDomAdapter({ digest: gatedDigest, driver });
    const catalog = await adapter.discoverCatalog();

    const starting = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink([]));
    const rejection = expect(starting).rejects.toMatchObject({
      failure: { code: "browser_state_changed", retryable: true },
    });
    await waitUntil(() => digestCalls === 3);
    driver.options = [{ ...modelOption("Web Alpha"), displayName: "WEB ALPHA" }];
    gate.resolve();

    await rejection;
    expect(digestCalls).toBe(4);
    expect(driver.prompt).toBeUndefined();
  });

  it("marks an uncertain post-handoff failure non-retryable to prevent replay", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    driver.startBehavior = "reject";

    await expect(
      adapter.startTurn(turnCommand(catalog, "turn-1"), createSink([])),
    ).rejects.toMatchObject({
      failure: {
        code: "browser_state_changed",
        message: "ChatGPT Web could not confirm the submitted text turn.",
        retryable: false,
      },
    });
    expect(driver.prompt).toBe("first");
  });

  it("does not report cancellation when a queued stop was never visibly confirmed", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    const gate = rejectableDeferred();
    const events: string[] = [];
    driver.cancelBehavior = "accept-without-terminal";
    driver.startBehavior = "pending";
    driver.startGate = gate.promise;

    const starting = adapter.startTurn(turnCommand(catalog, "turn-1"), createSink(events));
    const rejection = expect(starting).rejects.toMatchObject({
      failure: {
        code: "browser_state_changed",
        retryable: false,
      },
    });
    await waitUntil(() => driver.prompt !== undefined);
    await adapter.cancelTurn("turn-1");
    gate.reject(new Error("synthetic start confirmation failure"));

    await rejection;
    expect(events).not.toContain("cancelled:turn-1");
  });

  it("marks a monitor failure after visible start non-retryable", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    const catalog = await adapter.discoverCatalog();
    let retryable: boolean | undefined;
    driver.startBehavior = "fail";

    await adapter.startTurn(turnCommand(catalog, "turn-1"), {
      ...createSink([]),
      failed: (_turnId, failure) => {
        retryable = failure.retryable;
      },
    });

    expect(retryable).toBe(false);
  });

  it("fails closed on ambiguous visible model labels", async () => {
    const driver = new FakeUiDriver([
      modelOption("Web Alpha"),
      {
        displayName: "Web Alpha",
        selected: false,
        semanticKey: modelOption("Web Alpha").semanticKey,
      },
    ]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    await expect(adapter.discoverCatalog()).rejects.toMatchObject({
      failure: {
        code: "adapter_unavailable",
        message: "The ChatGPT Web model picker contains ambiguous options.",
        retryable: true,
      },
    });
  });

  it("closes idempotently and rejects operations after disposal", async () => {
    const driver = new FakeUiDriver([modelOption("Web Alpha")]);
    const adapter = new ChatGptDomAdapter({ digest, driver });
    adapter.dispose();
    adapter.dispose();

    await expect(adapter.discoverCatalog()).rejects.toMatchObject({
      failure: {
        code: "adapter_unavailable",
        message: "The page adapter is closed.",
        retryable: true,
      },
    });
  });
});

class FakeUiDriver implements ChatGptUiDriver {
  public agentOutput = "hello";
  public cancelBehavior: "accept-without-terminal" | "terminal" = "terminal";
  public discoveryGate: Promise<void> = Promise.resolve();
  public options: readonly ObservedModelOption[];
  public optionsAfterSelection: readonly ObservedModelOption[] | undefined;
  public preparationGate: Promise<void> = Promise.resolve();
  public preparationStarted = false;
  public prompt: string | undefined;
  public selectionGate: Promise<void> = Promise.resolve();
  public selectionStarted = false;
  public selectedSemanticKey: string | undefined;
  public startBehavior: "complete" | "fail" | "pending" | "reject" | "stream" | "wait" = "complete";
  public startGate: Promise<void> = Promise.resolve();
  #activeObserver: ChatGptUiTurnObserver | undefined;
  #catalogObserver: ((options: readonly ObservedModelOption[]) => void) | undefined;

  public constructor(options: readonly ObservedModelOption[]) {
    this.options = options;
  }

  public cancelTextTurn(): Promise<boolean> {
    const observer = this.#activeObserver;
    if (observer === undefined) {
      return Promise.resolve(false);
    }
    if (this.cancelBehavior === "accept-without-terminal") {
      return Promise.resolve(true);
    }
    this.#activeObserver = undefined;
    observer.cancelled();
    return Promise.resolve(true);
  }

  public async discoverModelOptions(): Promise<readonly ObservedModelOption[]> {
    await this.discoveryGate;
    return this.options;
  }

  public dispose(): void {
    this.#activeObserver = undefined;
    this.#catalogObserver = undefined;
  }

  public observeModelOptions(
    listener: (options: readonly ObservedModelOption[]) => void,
  ): () => void {
    this.#catalogObserver = listener;
    return () => {
      if (this.#catalogObserver === listener) {
        this.#catalogObserver = undefined;
      }
    };
  }

  public async selectModel(semanticKey: string): Promise<boolean> {
    this.selectionStarted = true;
    await this.selectionGate;
    this.selectedSemanticKey = semanticKey;
    const selected = this.options.some((option) => option.semanticKey === semanticKey);
    if (selected) {
      this.options = this.options.map((option) => ({
        ...option,
        selected: option.semanticKey === semanticKey,
      }));
      if (this.optionsAfterSelection !== undefined) {
        this.options = this.optionsAfterSelection;
        this.optionsAfterSelection = undefined;
      }
    }
    return selected;
  }

  public startTextTurn(
    prompt: string,
    semanticKey: string,
    preparation: ChatGptUiTurnPreparation,
    observer: ChatGptUiTurnObserver,
  ): Promise<ChatGptUiTurnStartOutcome> {
    return this.#startTurn(prompt, semanticKey, preparation, observer, false);
  }

  public startAgentTurn(
    prompt: string,
    semanticKey: string,
    preparation: ChatGptUiTurnPreparation,
    observer: ChatGptUiTurnObserver,
  ): Promise<ChatGptUiTurnStartOutcome> {
    return this.#startTurn(prompt, semanticKey, preparation, observer, true);
  }

  async #startTurn(
    prompt: string,
    semanticKey: string,
    preparation: ChatGptUiTurnPreparation,
    observer: ChatGptUiTurnObserver,
    agent: boolean,
  ): Promise<ChatGptUiTurnStartOutcome> {
    this.preparationStarted = true;
    await this.preparationGate;
    if (
      !preparation.acceptModelOptions(this.options) ||
      this.options.filter((option) => option.semanticKey === semanticKey && option.selected)
        .length !== 1
    ) {
      throw new Error("synthetic picker drift");
    }
    if (!preparation.shouldSubmit()) {
      return "cancelled-before-submit";
    }
    preparation.onSubmitting();
    this.prompt = prompt;
    if (this.startBehavior === "reject") {
      throw new Error("synthetic uncertain handoff");
    }
    this.#activeObserver = observer;
    if (this.startBehavior === "pending") {
      await this.startGate;
      return "submitted";
    }
    observer.started();
    if (this.startBehavior === "fail") {
      this.#activeObserver = undefined;
      observer.failed();
      return "submitted";
    }
    if (this.startBehavior !== "wait") {
      observer.outputText("hello");
    }
    if (this.startBehavior === "complete") {
      this.#activeObserver = undefined;
      observer.completed(agent ? this.agentOutput : undefined);
    }
    return "submitted";
  }

  public observe(options: readonly ObservedModelOption[]): void {
    this.options = options;
    this.#catalogObserver?.(options);
  }
}

function modelOption(displayName: string, selected = true): ObservedModelOption {
  return {
    displayName,
    selected,
    semanticKey: `menu:models|menuitemradio:${displayName}`,
  };
}

function turnCommand(catalog: AdapterCatalog, turnId: string): PageTurnStartMessage {
  const model = catalog.models[0];
  if (model === undefined) {
    throw new Error("missing fixture model");
  }
  return {
    catalogRevision: catalog.catalogRevision,
    input: [{ text: "first", type: "text" }],
    modelId: model.id,
    protocolVersion: 1,
    reasoningEffort: "medium",
    requestId: `request-${turnId}`,
    sequence: 1,
    temporary: false,
    turnId,
    type: "page/turn/start",
  };
}

function agentTurnCommand(catalog: AdapterCatalog, turnId: string): PageAgentTurnStartMessage {
  const model = catalog.models[0];
  if (model === undefined) {
    throw new Error("missing fixture model");
  }
  const activation = {
    binding: { documentId: "document-1", generation: 1, tabId: 7 },
    conversationOwnershipId: "ownership-1",
    expiresAtMs: 901_000,
    issuedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    leaseId: "lease-1",
    revision: 1,
    state: "active",
  } as const;
  return {
    catalogRevision: catalog.catalogRevision,
    input: [{ text: "GSB/2 BEGIN\n{}\nGSB/2 END", type: "text" }],
    modelId: model.id,
    permit: { activation, turnId },
    protocolVersion: 1,
    reasoningEffort: "medium",
    requestId: `request-${turnId}`,
    sequence: 1,
    temporary: false,
    turnId,
    type: "page/agent/turn/start",
  };
}

function createSink(events: string[]): ChatGptDomAdapterSink {
  return {
    cancelled: (turnId) => events.push(`cancelled:${turnId}`),
    completed: (turnId) => events.push(`completed:${turnId}`),
    failed: (turnId, failure) => events.push(`failed:${turnId}:${failure.code}`),
    outputText: (turnId, delta) => events.push(`delta:${turnId}:${delta}`),
    started: (turnId) => events.push(`started:${turnId}`),
  };
}

function createAgentSink(events: string[], completed: string[]): ChatGptDomAgentSink {
  return {
    cancelled: (turnId) => events.push(`cancelled:${turnId}`),
    completed: (turnId, outputText) => {
      events.push(`completed:${turnId}`);
      completed.push(outputText);
    },
    failed: (turnId, failure) => events.push(`failed:${turnId}:${failure.code}`),
    started: (turnId) => events.push(`started:${turnId}`),
  };
}

function digest(value: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(value).digest("hex"));
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => resolvePromise?.(),
  };
}

function rejectableDeferred(): {
  readonly promise: Promise<void>;
  reject(error: Error): void;
} {
  let rejectPromise: ((error: Error) => void) | undefined;
  return {
    promise: new Promise<void>((_resolve, reject) => {
      rejectPromise = reject;
    }),
    reject: (error) => rejectPromise?.(error),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("synthetic observation did not settle");
}
