import { describe, expect, it } from "vitest";

import {
  createChromeExtensionOrigin,
  validateExtensionOrigin,
} from "../src/runtime/extension-origin.js";
import type { ExtensionOriginError } from "../src/runtime/extension-origin.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

describe("extension origin validation", () => {
  it("creates and validates an exact canonical Chrome extension origin", () => {
    expect(createChromeExtensionOrigin(EXTENSION_ID)).toBe(EXTENSION_ORIGIN);
    expect(validateExtensionOrigin(EXTENSION_ORIGIN, [EXTENSION_ORIGIN])).toBe(EXTENSION_ORIGIN);
  });

  it("rejects wildcard, path-bearing, uppercase, and unlisted origins", () => {
    for (const origin of [
      "chrome-extension://*/",
      `${EXTENSION_ORIGIN}page.html`,
      `chrome-extension://${EXTENSION_ID.toUpperCase()}/`,
      "https://chatgpt.com/",
    ]) {
      expect(() => validateExtensionOrigin(origin, [EXTENSION_ORIGIN])).toThrow(
        expect.objectContaining<Partial<ExtensionOriginError>>({ code: "invalid_origin" }),
      );
    }
  });

  it("requires exactly one canonical origin in the allowlist", () => {
    const malformedAllowlists = [
      [],
      ["chrome-extension://*/"],
      [EXTENSION_ORIGIN, EXTENSION_ORIGIN],
      [EXTENSION_ORIGIN, `chrome-extension://${"a".repeat(32)}/`],
    ];

    for (const allowlist of malformedAllowlists) {
      expect(() => validateExtensionOrigin(EXTENSION_ORIGIN, allowlist)).toThrow(
        expect.objectContaining<Partial<ExtensionOriginError>>({ code: "invalid_allowlist" }),
      );
    }
  });

  it("rejects malformed extension identifiers", () => {
    expect(() => createChromeExtensionOrigin("not-an-extension-id")).toThrow(
      expect.objectContaining<Partial<ExtensionOriginError>>({ code: "invalid_origin" }),
    );
  });
});
