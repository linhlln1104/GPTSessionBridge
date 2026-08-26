import { afterEach, describe, expect, it } from "vitest";

import { installPopupController } from "../src/popup/popup-controller.js";
import type { UiResponse } from "../src/protocol/ui-messages.js";

describe("tool activation popup", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("requires consent and an explicit click, then offers explicit deactivation", async () => {
    installFixture();
    const runtime = new PopupRuntimeHarness();
    const refresh = createRefreshHarness();
    const controller = installPopupController({
      document,
      now: () => 1_000,
      runtime,
      scheduleRefresh: refresh.schedule,
    });

    await waitFor(() => runtime.requests.length === 1 && !consent().disabled);
    expect(runtime.requests).toEqual([{ type: "ui/status/read" }]);
    expect(activate().disabled).toBe(true);
    expect(deactivate().disabled).toBe(true);
    expect(toolStatus().textContent).toContain("starts inactive");

    consent().click();
    expect(activate().disabled).toBe(false);
    expect(runtime.requests).toHaveLength(1);

    activate().click();
    await waitFor(() => runtime.requests.length === 2 && !deactivate().disabled);
    expect(runtime.requests[1]).toEqual({
      disclosureVersion: "visible-chat-data-v1",
      selectionRevision: 7,
      type: "ui/tool-activation/activate",
    });
    expect(toolStatus().textContent).toContain("tool consent lease is active for this tab");
    expect(consent().checked).toBe(false);
    expect(consent().disabled).toBe(true);

    deactivate().click();
    await waitFor(() => runtime.requests.length === 3 && !consent().disabled);
    expect(runtime.requests[2]).toEqual({ type: "ui/tool-activation/deactivate" });
    expect(toolStatus().textContent).toContain("you deactivated it");

    controller.dispose();
    expect(refresh.cancelled).toBe(true);
  });

  it("does not let a stale status read overwrite a completed activation command", async () => {
    installFixture();
    const firstRead = deferred<unknown>();
    const runtime = new PopupRuntimeHarness(firstRead.promise);
    const refresh = createRefreshHarness();
    const controller = installPopupController({
      document,
      now: () => 1_000,
      runtime,
      scheduleRefresh: refresh.schedule,
    });

    await waitFor(() => runtime.requests.length === 1);
    refresh.run();
    await waitFor(() => runtime.requests.length === 2 && !consent().disabled);
    consent().click();
    activate().click();
    await waitFor(() => runtime.requests.length === 3 && !deactivate().disabled);

    firstRead.resolve(inactiveResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(toolStatus().textContent).toContain("tool consent lease is active for this tab");
    expect(deactivate().disabled).toBe(false);

    controller.dispose();
  });

  it("fails closed when the popup receives an invalid status response", async () => {
    installFixture();
    const refresh = createRefreshHarness();
    const controller = installPopupController({
      document,
      now: () => 1_000,
      runtime: { sendMessage: () => Promise.resolve({ ok: true }) },
      scheduleRefresh: refresh.schedule,
    });

    await waitFor(() => toolStatus().textContent.includes("treated as inactive"));
    expect(consent().disabled).toBe(true);
    expect(activate().disabled).toBe(true);
    expect(deactivate().disabled).toBe(true);
    controller.dispose();
  });

  it("clears consent on selection changes and accepts an MV3 restart reset", async () => {
    installFixture();
    const runtime = new PopupRuntimeHarness();
    const refresh = createRefreshHarness();
    const controller = installPopupController({
      document,
      now: () => 1_000,
      runtime,
      scheduleRefresh: refresh.schedule,
    });

    await waitFor(() => !consent().disabled);
    consent().click();
    runtime.setCurrent(inactiveResponse("extension_restart", 0, 8));
    refresh.run();
    await waitFor(() => !consent().checked);
    expect(activate().disabled).toBe(true);

    runtime.setCurrent(activeResponse(8));
    refresh.run();
    await waitFor(() => !deactivate().disabled);
    runtime.setCurrent(inactiveResponse("extension_restart", 0, 8));
    refresh.run();
    await waitFor(() => toolStatus().textContent.includes("starts inactive"));
    expect(deactivate().disabled).toBe(true);

    controller.dispose();
  });
});

class PopupRuntimeHarness {
  public readonly requests: unknown[] = [];
  #current = inactiveResponse();
  readonly #firstRead: Promise<unknown> | undefined;
  #statusReadCount = 0;

  public constructor(firstRead?: Promise<unknown>) {
    this.#firstRead = firstRead;
  }

  public sendMessage(message: unknown): Promise<unknown> {
    this.requests.push(message);
    const type = readType(message);
    if (type === "ui/status/read") {
      this.#statusReadCount += 1;
      if (this.#statusReadCount === 1 && this.#firstRead !== undefined) {
        return this.#firstRead;
      }
    } else if (type === "ui/tool-activation/activate") {
      this.#current = activeResponse();
    } else if (type === "ui/tool-activation/deactivate") {
      this.#current = inactiveResponse("deactivated", 2);
    }
    return Promise.resolve(this.#current);
  }

  public setCurrent(value: UiResponse): void {
    this.#current = value;
  }
}

function installFixture(): void {
  document.body.innerHTML = `
    <main>
      <p id="status" role="status" aria-live="polite"></p>
      <button id="connect" type="button">Connect</button>
      <button id="disconnect" type="button">Disconnect</button>
      <p id="tool-status" role="status" aria-live="polite"></p>
      <p id="tool-disclosure">Visible ChatGPT retention disclosure.</p>
      <label>
        <input id="tool-consent" type="checkbox" aria-describedby="tool-disclosure tool-status" />
        I understand.
      </label>
      <button id="activate-tools" type="button" disabled>Activate</button>
      <button id="deactivate-tools" type="button" disabled>Deactivate</button>
    </main>
  `;
}

function inactiveResponse(
  reason: "deactivated" | "extension_restart" = "extension_restart",
  revision = 0,
  selectionRevision = 7,
): UiResponse {
  return {
    activation: {
      disclosureVersion: "visible-chat-data-v1",
      expiresAtMs: null,
      inactivityTimeoutMs: 900_000,
      reason,
      revision,
      state: "inactive",
    },
    ok: true,
    selectionRevision,
    status: { reason: "none", state: "connected" },
  };
}

function activeResponse(selectionRevision = 7): UiResponse {
  return {
    activation: {
      disclosureVersion: "visible-chat-data-v1",
      expiresAtMs: 901_000,
      inactivityTimeoutMs: 900_000,
      reason: "user_activated",
      revision: 1,
      state: "active",
    },
    ok: true,
    selectionRevision,
    status: { reason: "none", state: "connected" },
  };
}

function createRefreshHarness(): {
  readonly cancelled: boolean;
  run(): void;
  readonly schedule: (callback: () => void) => () => void;
} {
  let callback: (() => void) | undefined;
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    run(): void {
      callback?.();
    },
    schedule(value): () => void {
      callback = value;
      return () => {
        cancelled = true;
      };
    },
  };
}

function consent(): HTMLInputElement {
  return requireElement("tool-consent", HTMLInputElement);
}

function activate(): HTMLButtonElement {
  return requireElement("activate-tools", HTMLButtonElement);
}

function deactivate(): HTMLButtonElement {
  return requireElement("deactivate-tools", HTMLButtonElement);
}

function toolStatus(): HTMLParagraphElement {
  return requireElement("tool-status", HTMLParagraphElement);
}

function requireElement<Type extends HTMLElement>(id: string, constructor: new () => Type): Type {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing fixture element: ${id}`);
  }
  return element;
}

function readType(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)["type"]
    : undefined;
}

function deferred<Type>(): { readonly promise: Promise<Type>; resolve(value: Type): void } {
  let resolvePromise: ((value: Type) => void) | undefined;
  const promise = new Promise<Type>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error("The popup fixture did not reach the expected state.");
}
