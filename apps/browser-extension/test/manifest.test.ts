import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DEVELOPMENT_EXTENSION_ID,
  DEVELOPMENT_EXTENSION_ORIGIN,
  NATIVE_MESSAGING_HOST_NAME,
} from "@gpt-session-bridge/native-messaging/link";
import { describe, expect, it } from "vitest";

import { NATIVE_HOST_NAME } from "../src/constants.js";

const manifestUrl = new URL("../manifest.json", import.meta.url);

describe("Manifest V3 policy", () => {
  it("declares only the minimum connection permissions", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, unknown>;

    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["minimum_chrome_version"]).toBe("106");
    expect(manifest["permissions"]).toEqual(["activeTab", "scripting", "nativeMessaging"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("uses a module service worker, explicit popup, and restrictive CSP", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, unknown>;

    expect(manifest["background"]).toEqual({
      service_worker: "background/service-worker.js",
      type: "module",
    });
    expect(manifest["action"]).toEqual({
      default_popup: "popup/popup.html",
      default_title: "Connect this ChatGPT tab",
    });
    expect(manifest["incognito"]).toBe("not_allowed");
    expect(manifest["content_security_policy"]).toEqual({
      extension_pages:
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
  });

  it("pins a public development key to the exact native-host origin", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, unknown>;
    const key = manifest["key"];
    expect(typeof key).toBe("string");
    const digest = createHash("sha256")
      .update(Buffer.from(key as string, "base64"))
      .digest()
      .subarray(0, 16);
    const alphabetStart = "a".charCodeAt(0);
    const extensionId = [...digest]
      .flatMap((byte) => [byte >> 4, byte & 0x0f])
      .map((nibble) => String.fromCodePoint(alphabetStart + nibble))
      .join("");

    expect(extensionId).toBe(DEVELOPMENT_EXTENSION_ID);
    expect(DEVELOPMENT_EXTENSION_ORIGIN).toBe(`chrome-extension://${DEVELOPMENT_EXTENSION_ID}/`);
    expect(NATIVE_HOST_NAME).toBe(NATIVE_MESSAGING_HOST_NAME);
  });
});
