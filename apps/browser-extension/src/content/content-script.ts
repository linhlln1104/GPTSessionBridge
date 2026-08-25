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

const EXPECTED_ORIGIN = "https://chatgpt.com";
const INSTALLATION_MARKER = "__gptSessionBridgeContentV1__";
const PAGE_PORT_NAME = "gptsessionbridge-page-v1";
const PROTOCOL_VERSION = 1;

const contentGlobal = globalThis as typeof globalThis & Record<string, unknown>;

if (contentGlobal[INSTALLATION_MARKER] !== true) {
  contentGlobal[INSTALLATION_MARKER] = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PAGE_PORT_NAME || location.origin !== EXPECTED_ORIGIN) {
      port.disconnect();
      return;
    }

    port.onMessage.addListener((message) => {
      if (!isPageProbe(message)) {
        port.disconnect();
        return;
      }
      port.postMessage({
        adapter: "unavailable",
        protocolVersion: PROTOCOL_VERSION,
        type: "page/ready",
      });
    });
  });
}

function isPageProbe(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("protocolVersion") &&
    keys.includes("type") &&
    record["protocolVersion"] === PROTOCOL_VERSION &&
    record["type"] === "page/probe"
  );
}
