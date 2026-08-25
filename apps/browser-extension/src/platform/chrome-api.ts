export interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
}

export interface ChromePort {
  readonly name: string;
  readonly onDisconnect: ChromeEvent<() => void>;
  readonly onMessage: ChromeEvent<(message: unknown) => void>;
  disconnect(): void;
  postMessage(message: unknown): void;
}

export interface ChromeTab {
  readonly active?: boolean;
  readonly id?: number;
  readonly url?: string;
  readonly windowId?: number;
}

export interface ChromeMessageSender {
  readonly documentId?: string;
  readonly frameId?: number;
  readonly id?: string;
  readonly tab?: ChromeTab;
  readonly url?: string;
}

export interface ChromeInjectionResult {
  readonly documentId: string;
  readonly frameId: number;
  readonly result?: unknown;
}

export interface ChromeApi {
  readonly runtime: {
    readonly id: string;
    readonly onMessage: ChromeEvent<
      (
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined
    >;
    connectNative(application: string): ChromePort;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
  };
  readonly scripting: {
    executeScript(injection: {
      readonly files: readonly string[];
      readonly target: {
        readonly frameIds: readonly number[];
        readonly tabId: number;
      };
      readonly world: "ISOLATED";
    }): Promise<readonly ChromeInjectionResult[]>;
  };
  readonly tabs: {
    connect(
      tabId: number,
      options: { readonly documentId: string; readonly name: string },
    ): ChromePort;
    query(queryInfo: {
      readonly active: true;
      readonly currentWindow: true;
    }): Promise<readonly ChromeTab[]>;
  };
}

export function readChromeApi(): ChromeApi {
  const value = (globalThis as typeof globalThis & { readonly chrome?: ChromeApi }).chrome;
  if (value === undefined) {
    throw new Error("Chrome extension APIs are unavailable.");
  }
  return value;
}
