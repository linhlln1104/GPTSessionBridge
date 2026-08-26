import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserChatGptUiDriver } from "../src/content/browser-chatgpt-ui-driver.js";
import type {
  ChatGptUiTurnObserver,
  ObservedModelOption,
} from "../src/content/chatgpt-dom-adapter.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

interface SubmittedTurn {
  readonly assistant: HTMLElement;
  readonly prompt: string;
  readonly stop: HTMLButtonElement;
}

interface SyntheticChatGptSurface {
  readonly editor: HTMLTextAreaElement;
  readonly menu: HTMLElement;
  readonly modelOptions: readonly HTMLElement[];
  readonly rootMenu: HTMLElement;
  readonly sendCount: () => number;
  readonly submitted: Deferred<SubmittedTurn>;
  readonly trigger: HTMLButtonElement;
}

interface SyntheticChatGptSurfaceOptions {
  readonly onSubmit?: () => void;
}

const agentEnvelopeFixtures = Object.freeze([
  Object.freeze({
    kind: "tool_call" as const,
    output: `GSB/2 BEGIN\n${JSON.stringify({
      arguments: { cmd: "Get-ChildItem -Force" },
      challenge: "A".repeat(32),
      kind: "tool_call",
      manifestDigest: `sha256-${"A".repeat(43)}`,
      round: 0,
      tool: "exec_command",
      turn: `wt_${"a".repeat(16)}`,
      v: 2,
    })}\nGSB/2 END`,
  }),
  Object.freeze({
    kind: "final" as const,
    output: `GSB/2 BEGIN\n${JSON.stringify({
      challenge: "B".repeat(32),
      kind: "final",
      manifestDigest: `sha256-${"E".repeat(43)}`,
      round: 1,
      text: "Done with non-breaking space:\u00a0and two trailing spaces  ",
      turn: `wt_${"b".repeat(16)}`,
      v: 2,
    })}\nGSB/2 END`,
  }),
]);

const activeDrivers = new Set<BrowserChatGptUiDriver>();

beforeEach(() => {
  document.body.replaceChildren();
  document.head.querySelector("style[data-gsb-browser-fixture]")?.remove();
});

afterEach(() => {
  for (const driver of activeDrivers) {
    driver.dispose();
  }
  activeDrivers.clear();
  document.body.replaceChildren();
});

describe("BrowserChatGptUiDriver in Chrome", () => {
  it("discovers and confirms the nested Model submenu", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();

    const catalog = await driver.discoverModelOptions();

    expect(catalog.map(({ displayName, selected }) => ({ displayName, selected }))).toEqual([
      { displayName: "GPT-5.6 Sol", selected: true },
      { displayName: "GPT-5.5", selected: false },
    ]);
    expect(surface.menu.hidden).toBe(true);
    expect(surface.rootMenu.hidden).toBe(true);

    const second = catalog[1];
    expect(second).toBeDefined();
    expect(await driver.selectModel(second?.semanticKey ?? "missing")).toBe(true);
    expect(surface.modelOptions.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ]);
    expect(surface.menu.hidden).toBe(true);
    expect(surface.rootMenu.hidden).toBe(true);
  });

  it("rejects final raw-picker drift without touching the composer or Send", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();
    const catalog = await driver.discoverModelOptions();
    const selected = readSelected(catalog);
    expect(await driver.selectModel(selected.semanticKey)).toBe(true);
    const drifted = surface.modelOptions[1];
    expect(drifted).toBeDefined();
    if (drifted !== undefined) {
      drifted.textContent = "Changed after catalog publication";
    }

    await expect(
      driver.startTextTurn(
        "This must not be submitted.",
        selected.semanticKey,
        {
          acceptModelOptions: (options) => sameCatalog(options, catalog),
          onSubmitting: () => undefined,
          shouldSubmit: () => true,
        },
        observerFor(deferred()),
      ),
    ).rejects.toThrow("model_picker_changed");
    expect(surface.editor.value).toBe("");
    expect(surface.sendCount()).toBe(0);
    expect(surface.menu.hidden).toBe(true);
    expect(surface.rootMenu.hidden).toBe(true);
  });

  it("observes live picker changes and stops after unsubscribe", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();
    await driver.discoverModelOptions();
    const observed: (readonly ObservedModelOption[])[] = [];
    const unsubscribe = driver.observeModelOptions((options) => {
      observed.push(options);
    });

    surface.trigger.click();
    const submenu = surface.rootMenu.querySelector<HTMLButtonElement>(
      'button[aria-controls="gsb-model-menu"]',
    );
    expect(submenu).not.toBeNull();
    submenu?.click();
    await waitUntil(() => observed.length === 1);

    const changed = surface.modelOptions[1];
    expect(changed).toBeDefined();
    if (changed !== undefined) {
      changed.textContent = "GPT-5.4";
    }
    await waitUntil(() => observed.length === 2);
    expect(observed.at(-1)?.map((option) => option.displayName)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.4",
    ]);

    unsubscribe();
    if (changed !== undefined) {
      changed.textContent = "GPT-5.3";
    }
    await delay(50);
    expect(observed).toHaveLength(2);
  });

  it("submits, adopts the visible conversation, streams text, and completes", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();
    const catalog = await driver.discoverModelOptions();
    const selected = readSelected(catalog);
    const terminal = deferred<"cancelled" | "completed" | "failed">();
    const deltas: string[] = [];
    let submitting = 0;
    let started = 0;

    const outcomePromise = driver.startTextTurn(
      "Inspect the synthetic fixture.",
      selected.semanticKey,
      {
        acceptModelOptions: (options) => sameCatalog(options, catalog),
        onSubmitting: () => {
          submitting += 1;
        },
        shouldSubmit: () => true,
      },
      observerFor(terminal, deltas, () => {
        started += 1;
      }),
    );
    const submitted = await surface.submitted.promise;
    const outcome = await outcomePromise;

    expect(outcome).toBe("submitted");
    expect(submitting).toBe(1);
    expect(started).toBe(1);
    expect(submitted.prompt).toBe("Inspect the synthetic fixture.");
    expect(surface.editor.value).toBe("");

    const visible = document.createElement("p");
    visible.textContent = "Visible Chrome delta";
    const hidden = document.createElement("span");
    hidden.hidden = true;
    hidden.textContent = "Hidden fixture content";
    const action = document.createElement("button");
    action.textContent = "Copy fixture content";
    submitted.assistant.replaceChildren(visible, hidden, action);
    await waitUntil(() => deltas.join("") === "Visible Chrome delta");
    submitted.stop.remove();

    await expect(withTimeout(terminal.promise)).resolves.toBe("completed");
    expect(deltas.join("")).toBe("Visible Chrome delta");
  });

  it.each(agentEnvelopeFixtures)(
    "preserves a streamed $kind envelope byte-for-byte and adopts only its first owned route",
    async ({ kind, output: exactOutput }) => {
      const locationValue = {
        origin: "https://chatgpt.com",
        pathname: "/",
      } as Location;
      const driverReference: { current?: BrowserChatGptUiDriver } = {};
      let decisionDuringSubmit: "adopt" | "defer" | "reject" | undefined;
      let secondDecisionDuringSubmit: "adopt" | "defer" | "reject" | undefined;
      const surface = mountSyntheticChatGptSurface({
        onSubmit: () => {
          locationValue.pathname = "/c/synthetic-owned";
          const currentDriver = driverReference.current;
          if (currentDriver === undefined) {
            throw new Error("synthetic driver was not installed");
          }
          decisionDuringSubmit = currentDriver.decideNavigation(
            "https://chatgpt.com/",
            "https://chatgpt.com/c/synthetic-owned",
          );
          secondDecisionDuringSubmit = currentDriver.decideNavigation(
            "https://chatgpt.com/",
            "https://chatgpt.com/c/second-before-adoption",
          );
        },
      });
      const driver = createDriver(locationValue);
      driverReference.current = driver;
      const catalog = await driver.discoverModelOptions();
      const selected = readSelected(catalog);
      const completedOutput = deferred<string>();
      const terminal = deferred<"cancelled" | "completed" | "failed">();
      const deltas: string[] = [];
      const outcomePromise = driver.startAgentTurn(
        "GSB/2 BEGIN\n{}\nGSB/2 END",
        selected.semanticKey,
        {
          acceptModelOptions: (options) => sameCatalog(options, catalog),
          onSubmitting: () => undefined,
          shouldSubmit: () => true,
        },
        {
          cancelled: () => {
            terminal.resolve("cancelled");
          },
          completed: (outputText) => {
            if (outputText !== undefined) {
              completedOutput.resolve(outputText);
            }
            terminal.resolve("completed");
          },
          failed: () => {
            terminal.resolve("failed");
          },
          outputText: (delta) => {
            deltas.push(delta);
          },
          started: () => undefined,
        },
      );
      const submitted = await surface.submitted.promise;
      await expect(outcomePromise).resolves.toBe("submitted");

      expect(decisionDuringSubmit).toBe("defer");
      expect(secondDecisionDuringSubmit).toBe("reject");
      expect(
        driver.decideNavigation("https://chatgpt.com/", "https://chatgpt.com/c/synthetic-owned"),
      ).toBe("adopt");
      expect(
        driver.decideNavigation(
          "https://chatgpt.com/c/synthetic-owned",
          "https://chatgpt.com/c/other",
        ),
      ).toBe("reject");

      const hidden = document.createElement("span");
      hidden.hidden = true;
      hidden.textContent = "must-not-leak";
      const action = document.createElement("button");
      action.textContent = "Copy";
      const splitAt = Math.floor(exactOutput.length / 2);
      const streamedText = document.createTextNode(exactOutput.slice(0, splitAt));
      submitted.assistant.replaceChildren(streamedText, hidden, action);
      await delay(25);
      expect(deltas).toEqual([]);
      streamedText.appendData(exactOutput.slice(splitAt));
      await delay(25);
      expect(deltas).toEqual([]);
      submitted.stop.remove();

      await expect(withTimeout(terminal.promise)).resolves.toBe("completed");
      const actualOutput = await withTimeout(completedOutput.promise);
      expect(deltas).toEqual([]);
      expect(actualOutput).toBe(exactOutput);
      expect(new TextEncoder().encode(actualOutput)).toEqual(new TextEncoder().encode(exactOutput));
      expectExactAgentEnvelope(actualOutput, kind);
    },
  );

  it("cancels an agent turn only through the visible Stop control without leaking partial output", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();
    const catalog = await driver.discoverModelOptions();
    const selected = readSelected(catalog);
    const terminal = deferred<"cancelled" | "completed" | "failed">();
    const deltas: string[] = [];
    const outcomePromise = driver.startAgentTurn(
      "GSB/2 BEGIN\n{}\nGSB/2 END",
      selected.semanticKey,
      {
        acceptModelOptions: (options) => sameCatalog(options, catalog),
        onSubmitting: () => undefined,
        shouldSubmit: () => true,
      },
      observerFor(terminal, deltas),
    );
    const submitted = await surface.submitted.promise;
    await expect(outcomePromise).resolves.toBe("submitted");

    submitted.assistant.textContent = agentEnvelopeFixtures[0]?.output.slice(0, 40) ?? "partial";
    await delay(25);
    expect(deltas).toEqual([]);
    expect(submitted.stop.isConnected).toBe(true);
    await expect(driver.cancelTextTurn()).resolves.toBe(true);
    expect(submitted.stop.isConnected).toBe(false);
    await expect(withTimeout(terminal.promise)).resolves.toBe("cancelled");
    expect(deltas).toEqual([]);
  });

  it("fails an active agent turn when its adopted conversation route changes", async () => {
    const locationValue = {
      origin: "https://chatgpt.com",
      pathname: "/",
    } as Location;
    const surface = mountSyntheticChatGptSurface({
      onSubmit: () => {
        locationValue.pathname = "/c/synthetic-owned";
      },
    });
    const driver = createDriver(locationValue);
    const catalog = await driver.discoverModelOptions();
    const selected = readSelected(catalog);
    const terminal = deferred<"cancelled" | "completed" | "failed">();
    const outcomePromise = driver.startAgentTurn(
      "GSB/2 BEGIN\n{}\nGSB/2 END",
      selected.semanticKey,
      {
        acceptModelOptions: (options) => sameCatalog(options, catalog),
        onSubmitting: () => undefined,
        shouldSubmit: () => true,
      },
      observerFor(terminal),
    );
    const submitted = await surface.submitted.promise;
    await expect(outcomePromise).resolves.toBe("submitted");
    submitted.assistant.textContent = agentEnvelopeFixtures[1]?.output ?? "response";

    locationValue.pathname = "/c/unowned-navigation";
    submitted.assistant.append(document.createTextNode(" "));

    await expect(withTimeout(terminal.promise)).resolves.toBe("failed");
  });

  it("reports cancellation only after clicking a visible Stop control", async () => {
    const surface = mountSyntheticChatGptSurface();
    const driver = createDriver();
    const catalog = await driver.discoverModelOptions();
    const selected = readSelected(catalog);
    const terminal = deferred<"cancelled" | "completed" | "failed">();
    const outcomePromise = driver.startTextTurn(
      "Cancel this synthetic turn.",
      selected.semanticKey,
      {
        acceptModelOptions: (options) => sameCatalog(options, catalog),
        onSubmitting: () => undefined,
        shouldSubmit: () => true,
      },
      observerFor(terminal),
    );
    const submitted = await surface.submitted.promise;

    await expect(outcomePromise).resolves.toBe("submitted");
    expect(submitted.stop.isConnected).toBe(true);
    await expect(driver.cancelTextTurn()).resolves.toBe(true);
    expect(submitted.stop.isConnected).toBe(false);
    await expect(withTimeout(terminal.promise)).resolves.toBe("cancelled");
  });
});

function createDriver(
  locationValue: Location = Object.freeze({
    origin: "https://chatgpt.com",
    pathname: "/",
  }) as Location,
): BrowserChatGptUiDriver {
  const driver = new BrowserChatGptUiDriver({
    document,
    location: locationValue,
  });
  activeDrivers.add(driver);
  return driver;
}

function mountSyntheticChatGptSurface(
  options: SyntheticChatGptSurfaceOptions = {},
): SyntheticChatGptSurface {
  const style = document.createElement("style");
  style.dataset["gsbBrowserFixture"] = "true";
  style.textContent =
    "[hidden]{display:none!important}.gsb-fixture{display:block}.gsb-message{display:block;min-height:1px}";
  document.head.append(style);

  const root = document.createElement("main");
  root.className = "gsb-fixture";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-controls", "gsb-root-menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-label", "Chat controls");
  trigger.textContent = "GPT-5.6 Sol";

  const rootMenu = document.createElement("div");
  rootMenu.id = "gsb-root-menu";
  rootMenu.hidden = true;
  rootMenu.setAttribute("role", "menu");
  const modelSubmenu = document.createElement("button");
  modelSubmenu.type = "button";
  modelSubmenu.setAttribute("aria-controls", "gsb-model-menu");
  modelSubmenu.setAttribute("aria-haspopup", "menu");
  modelSubmenu.setAttribute("role", "menuitem");
  const modelSubmenuLabel = document.createElement("span");
  modelSubmenuLabel.textContent = "Model";
  const currentModelLabel = document.createElement("span");
  currentModelLabel.textContent = "GPT-5.6 Sol";
  modelSubmenu.append(modelSubmenuLabel, currentModelLabel);
  const unrelatedControl = document.createElement("button");
  unrelatedControl.type = "button";
  unrelatedControl.setAttribute("role", "menuitem");
  unrelatedControl.textContent = "Temporary chat";
  rootMenu.append(modelSubmenu, unrelatedControl);

  const menu = document.createElement("div");
  menu.id = "gsb-model-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  const modelOptions = [
    createModelOption("GPT-5.6 Sol", true),
    createModelOption("GPT-5.5", false),
  ];
  menu.append(...modelOptions);

  trigger.addEventListener("click", () => {
    const opening = trigger.getAttribute("aria-expanded") !== "true";
    trigger.setAttribute("aria-expanded", opening ? "true" : "false");
    rootMenu.hidden = !opening;
    if (!opening) {
      menu.hidden = true;
    }
  });
  modelSubmenu.addEventListener("click", () => {
    menu.hidden = false;
  });
  for (const option of modelOptions) {
    option.addEventListener("click", () => {
      for (const candidate of modelOptions) {
        candidate.setAttribute("aria-checked", candidate === option ? "true" : "false");
      }
      trigger.textContent = option.textContent;
      currentModelLabel.textContent = option.textContent;
      trigger.setAttribute("aria-expanded", "false");
      menu.hidden = true;
      rootMenu.hidden = true;
    });
  }

  const transcript = document.createElement("section");
  transcript.setAttribute("aria-label", "Conversation");
  const form = document.createElement("form");
  const editor = document.createElement("textarea");
  editor.setAttribute("aria-label", "Message ChatGPT");
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  form.append(editor, send);

  const submitted = deferred<SubmittedTurn>();
  let sendCount = 0;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendCount += 1;
    const prompt = editor.value;
    editor.value = "";
    const user = document.createElement("div");
    user.className = "gsb-message";
    user.dataset["messageAuthorRole"] = "user";
    user.textContent = prompt;
    const assistant = document.createElement("div");
    assistant.className = "gsb-message";
    assistant.dataset["messageAuthorRole"] = "assistant";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.setAttribute("aria-label", "Stop generating");
    stop.textContent = "Stop";
    stop.addEventListener("click", () => {
      stop.remove();
    });
    transcript.append(user, assistant);
    form.append(stop);
    options.onSubmit?.();
    submitted.resolve(Object.freeze({ assistant, prompt, stop }));
  });

  root.append(trigger, rootMenu, menu, transcript, form);
  document.body.append(root);
  return Object.freeze({
    editor,
    menu,
    modelOptions: Object.freeze(modelOptions),
    rootMenu,
    sendCount: () => sendCount,
    submitted,
    trigger,
  });
}

function createModelOption(displayName: string, selected: boolean): HTMLElement {
  const option = document.createElement("button");
  option.type = "button";
  option.setAttribute("aria-checked", selected ? "true" : "false");
  option.setAttribute("role", "menuitemradio");
  option.textContent = displayName;
  return option;
}

function readSelected(options: readonly ObservedModelOption[]): ObservedModelOption {
  const selected = options.filter((option) => option.selected);
  if (selected.length !== 1 || selected[0] === undefined) {
    throw new Error("Synthetic fixture has no unique selected model");
  }
  return selected[0];
}

function sameCatalog(
  actual: readonly ObservedModelOption[],
  expected: readonly ObservedModelOption[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function expectExactAgentEnvelope(value: string, kind: "final" | "tool_call"): void {
  expect(value).not.toContain("\r");
  const lines = value.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe("GSB/2 BEGIN");
  expect(lines[2]).toBe("GSB/2 END");
  const body = lines[1];
  expect(body?.startsWith("{")).toBe(true);
  expect(body?.endsWith("}")).toBe(true);
  expect(JSON.parse(body ?? "null")).toMatchObject({ kind, v: 2 });
}

function observerFor(
  terminal: Deferred<"cancelled" | "completed" | "failed">,
  deltas: string[] = [],
  onStarted: () => void = () => undefined,
): ChatGptUiTurnObserver {
  return Object.freeze({
    cancelled: () => {
      terminal.resolve("cancelled");
    },
    completed: () => {
      terminal.resolve("completed");
    },
    failed: () => {
      terminal.resolve("failed");
    },
    outputText: (delta: string) => {
      deltas.push(delta);
    },
    started: onStarted,
  });
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the Chrome fixture");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs = 3_000): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("Timed out waiting for the Chrome fixture terminal"));
      }, timeoutMs);
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
