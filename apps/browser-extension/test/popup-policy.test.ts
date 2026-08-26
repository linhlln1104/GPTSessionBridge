import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const popupUrl = new URL("../src/popup/popup.html", import.meta.url);

describe("tool activation disclosure", () => {
  it("discloses every browser-visible data class and ChatGPT retention before consent", async () => {
    const source = await readFile(popupUrl, "utf8");

    expect(source).toContain("your coding request, developer context, and source excerpts");
    expect(source).toContain("tool names, definitions, and input schemas");
    expect(source).toContain("tool arguments");
    expect(source).toContain("tool results");
    expect(source).toContain("visible ChatGPT conversation");
    expect(source).toContain("may be retained");
    expect(source).toContain("Developer-role priority is not preserved");
    expect(source).toContain('id="tool-consent"');
    expect(source).toContain("exposes Web Agent models only while this tab is connected");
    expect(source).toContain("visible ChatGPT model picker");
    expect(source).not.toContain("Web Agent model remains unavailable in this build");
    expect(source).toContain('aria-describedby="tool-disclosure tool-availability tool-status"');
    expect(source).toContain('id="activate-tools" type="button" disabled');
  });

  it("provides distinct live status and explicit deactivate controls", async () => {
    const source = await readFile(popupUrl, "utf8");

    expect(source).toContain('id="status" role="status" aria-live="polite"');
    expect(source).toContain('id="tool-status" role="status" aria-live="polite"');
    expect(source).toContain('id="deactivate-tools" type="button" disabled');
  });
});
