import { readFile } from "node:fs/promises";

import {
  DEVELOPMENT_EXTENSION_ORIGIN,
  NATIVE_MESSAGING_HOST_NAME,
} from "@gpt-session-bridge/native-messaging/link";
import { describe, expect, it } from "vitest";

const manifestUrl = new URL("../manifest/chrome-windows.template.json", import.meta.url);

describe("Chrome Native Messaging manifest template", () => {
  it("pins the development extension and leaves installation paths unresolved", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, unknown>;

    expect(manifest).toEqual({
      allowed_origins: [DEVELOPMENT_EXTENSION_ORIGIN],
      description: "GPTSessionBridge Native Messaging host",
      name: NATIVE_MESSAGING_HOST_NAME,
      path: "__GPTSESSIONBRIDGE_NATIVE_HOST_EXECUTABLE__",
      type: "stdio",
    });
    expect(JSON.stringify(manifest)).not.toContain("*");
  });
});
