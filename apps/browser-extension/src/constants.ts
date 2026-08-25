import {
  BRIDGE_IMPLEMENTATION_VERSION,
  NATIVE_MESSAGING_HOST_NAME,
} from "@gpt-session-bridge/native-messaging/link";

export const CHATGPT_ORIGIN = "https://chatgpt.com" as const;
export const CONTENT_SCRIPT_PATH = "content/content-script.js" as const;
export const CONTENT_PORT_NAME = "gptsessionbridge-page-v1" as const;
export const EXTENSION_IMPLEMENTATION_VERSION = BRIDGE_IMPLEMENTATION_VERSION;
export const NATIVE_HOST_NAME = NATIVE_MESSAGING_HOST_NAME;
export const PAGE_PROTOCOL_VERSION = 1 as const;
export const POPUP_PATH = "popup/popup.html" as const;
export const UNAVAILABLE_CATALOG_REVISION = "browser-adapter-unavailable-v1" as const;
