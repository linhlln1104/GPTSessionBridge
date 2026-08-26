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

function createDriver(): BrowserChatGptUiDriver {
  const driver = new BrowserChatGptUiDriver({
    document,
    location: Object.freeze({ origin: "https://chatgpt.com", pathname: "/" }) as Location,
  });
  activeDrivers.add(driver);
  return driver;
}

function mountSyntheticChatGptSurface(): SyntheticChatGptSurface {
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
  modelSubmenu.textContent = "Model";
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
