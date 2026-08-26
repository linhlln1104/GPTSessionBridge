import { BrowserChatGptUiDriver } from "./browser-chatgpt-ui-driver.js";
import { observeDocumentNavigation } from "./document-navigation-monitor.js";
import {
  ChatGptDomAdapter,
  ChatGptDomAdapterError,
  type AdapterFailure,
  type ChatGptDomAdapterSink,
} from "./chatgpt-dom-adapter.js";
import { CHATGPT_ORIGIN, CONTENT_PORT_NAME } from "../constants.js";
import {
  PageClientLinkError,
  PageServerLink,
  type PageCommandMessage,
  type PageRuntimeEventInput,
} from "../protocol/page-messages.js";

interface ContentPortEvent<Listener> {
  addListener(listener: Listener): void;
}

interface ContentPort {
  readonly name: string;
  readonly onDisconnect: ContentPortEvent<() => void>;
  readonly onMessage: ContentPortEvent<(message: unknown) => void>;
  disconnect(): void;
  postMessage(message: unknown): void;
}

declare const chrome: {
  readonly runtime: {
    readonly onConnect: ContentPortEvent<(port: ContentPort) => void>;
  };
};

const INSTALLATION_MARKER = "__gptSessionBridgeContentV1__";
const contentGlobal = globalThis as typeof globalThis & Record<string, unknown>;

if (contentGlobal[INSTALLATION_MARKER] !== true) {
  contentGlobal[INSTALLATION_MARKER] = true;
  installContentRuntime();
}

function installContentRuntime(): void {
  let activePort: ContentPort | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    if (
      activePort !== undefined ||
      port.name !== CONTENT_PORT_NAME ||
      location.origin !== CHATGPT_ORIGIN
    ) {
      port.disconnect();
      return;
    }
    let runtime: ContentRuntime;
    try {
      runtime = new ContentRuntime(port);
    } catch {
      port.disconnect();
      return;
    }
    activePort = port;
    port.onDisconnect.addListener(() => {
      runtime.close();
      if (activePort === port) {
        activePort = undefined;
      }
    });
    port.onMessage.addListener((message) => {
      runtime.receive(message);
    });
  });
}

class ContentRuntime {
  readonly #adapter = new ChatGptDomAdapter({ driver: new BrowserChatGptUiDriver() });
  readonly #link = new PageServerLink();
  readonly #port: ContentPort;
  readonly #stopCatalogObservation: () => void;
  readonly #stopNavigationObservation: () => void;
  #active:
    | {
        readonly requestId: string;
        readonly turnId: string;
      }
    | undefined;
  #cancelRequestId: string | undefined;
  #closed = false;
  #ready = false;

  public constructor(port: ContentPort) {
    this.#port = port;
    this.#stopNavigationObservation = observeDocumentNavigation({
      document,
      onChanged: () => {
        if (this.#closed) {
          return;
        }
        if (!this.#ready) {
          this.close();
          return;
        }
        this.#send({ type: "page/document/changed" });
      },
      window,
    });
    this.#stopCatalogObservation = this.#adapter.onCatalogChanged((catalog) => {
      if (!this.#closed && this.#ready) {
        this.#send({
          catalogRevision: catalog.catalogRevision,
          models: catalog.models,
          type: "page/catalog/changed",
        });
      }
    });
  }

  public receive(value: unknown): void {
    if (this.#closed) {
      return;
    }
    let command: PageCommandMessage;
    try {
      command = this.#link.receive(value);
      if (command.type === "page/probe") {
        this.#ready = true;
        this.#post(this.#link.ready());
        return;
      }
    } catch {
      this.close();
      return;
    }
    // Dispatch synchronously up to each operation's first await. In particular,
    // this lets a following cancel command mark a turn while catalog/model
    // verification is still in flight, before any prompt is submitted.
    void this.#dispatch(command).catch(() => {
      this.close();
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#active = undefined;
    this.#cancelRequestId = undefined;
    this.#ready = false;
    this.#stopCatalogObservation();
    this.#stopNavigationObservation();
    this.#adapter.dispose();
    this.#link.close();
    try {
      this.#port.disconnect();
    } catch {
      // A disconnected document port is already in the desired terminal state.
    }
  }

  async #dispatch(
    command: Exclude<PageCommandMessage, { readonly type: "page/probe" }>,
  ): Promise<void> {
    switch (command.type) {
      case "page/catalog/read":
        await this.#readCatalog(command.requestId);
        return;
      case "page/turn/start":
        await this.#startTurn(command);
        return;
      case "page/turn/cancel":
        await this.#cancelTurn(command.requestId, command.turnId);
        return;
    }
  }

  async #readCatalog(requestId: string): Promise<void> {
    try {
      const catalog = await this.#adapter.discoverCatalog();
      this.#send({
        catalogRevision: catalog.catalogRevision,
        models: catalog.models,
        requestId,
        type: "page/catalog/result",
      });
    } catch (error) {
      this.#sendFailure(requestId, normalizeFailure(error));
    }
  }

  async #startTurn(
    command: Extract<PageCommandMessage, { readonly type: "page/turn/start" }>,
  ): Promise<void> {
    if (this.#active !== undefined) {
      this.#sendFailure(
        command.requestId,
        {
          code: "turn_already_active",
          message: "A ChatGPT Web turn is already active.",
          retryable: false,
        },
        command.turnId,
      );
      return;
    }
    const active = Object.freeze({ requestId: command.requestId, turnId: command.turnId });
    this.#active = active;
    try {
      await this.#adapter.startTurn(command, this.#createSink(command.requestId));
    } catch (error) {
      if (this.#active !== active) {
        return;
      }
      this.#active = undefined;
      this.#cancelRequestId = undefined;
      this.#sendFailure(command.requestId, normalizeFailure(error), command.turnId);
    }
  }

  async #cancelTurn(requestId: string, turnId: string): Promise<void> {
    if (this.#active?.turnId !== turnId || this.#cancelRequestId !== undefined) {
      this.#sendFailure(
        requestId,
        {
          code: "turn_not_found",
          message: "The requested ChatGPT Web turn cannot be cancelled.",
          retryable: false,
        },
        turnId,
      );
      return;
    }
    const active = this.#active;
    this.#cancelRequestId = requestId;
    try {
      await this.#adapter.cancelTurn(turnId);
    } catch (error) {
      // Completion/cancellation may have won while the DOM stop request was
      // awaiting confirmation. Its terminal event is authoritative.
      if (this.#active !== active) {
        return;
      }
      this.#cancelRequestId = undefined;
      this.#sendFailure(requestId, normalizeFailure(error), turnId);
    }
  }

  #createSink(startRequestId: string): ChatGptDomAdapterSink {
    const sink: ChatGptDomAdapterSink = {
      cancelled: (turnId) => {
        const requestId = this.#cancelRequestId ?? startRequestId;
        if (this.#finishTurn(turnId)) {
          this.#send({ requestId, turnId, type: "page/turn/cancelled" });
        }
      },
      completed: (turnId) => {
        if (this.#finishTurn(turnId)) {
          this.#send({ turnId, type: "page/turn/completed" });
        }
      },
      failed: (turnId, failure) => {
        if (this.#finishTurn(turnId)) {
          this.#sendFailure(startRequestId, failure, turnId);
        }
      },
      outputText: (turnId, delta) => {
        if (this.#active?.turnId === turnId) {
          this.#send({ delta, turnId, type: "page/turn/delta" });
        }
      },
      started: (turnId) => {
        if (this.#active?.turnId === turnId) {
          this.#send({ requestId: startRequestId, turnId, type: "page/turn/started" });
        }
      },
    };
    return Object.freeze(sink);
  }

  #finishTurn(turnId: string): boolean {
    if (this.#active?.turnId !== turnId) {
      return false;
    }
    this.#active = undefined;
    this.#cancelRequestId = undefined;
    return true;
  }

  #sendFailure(requestId: string, failure: AdapterFailure, turnId?: string): void {
    this.#send({
      code: failure.code,
      message: failure.message,
      requestId,
      retryable: failure.retryable,
      ...(turnId === undefined ? {} : { turnId }),
      type: "page/command/failed",
    });
  }

  #send(event: PageRuntimeEventInput): void {
    this.#post(this.#link.send(event));
  }

  #post(value: unknown): void {
    if (this.#closed) {
      throw new PageClientLinkError();
    }
    try {
      this.#port.postMessage(value);
    } catch {
      this.close();
      throw new PageClientLinkError();
    }
  }
}

function normalizeFailure(error: unknown): AdapterFailure {
  if (error instanceof ChatGptDomAdapterError) {
    return error.failure;
  }
  return Object.freeze({
    code: "browser_state_changed",
    message: "ChatGPT Web changed before the operation completed.",
    retryable: true,
  });
}
