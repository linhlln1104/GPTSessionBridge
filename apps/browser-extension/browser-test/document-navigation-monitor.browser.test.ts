import { describe, expect, it } from "vitest";

import { observeDocumentNavigation } from "../src/content/document-navigation-monitor.js";

describe("document navigation monitor", () => {
  it("detects a same-document History API navigation without page permissions", async () => {
    const originalUrl = window.location.href;
    let changed = 0;
    const stop = observeDocumentNavigation({
      document,
      onChanged: () => {
        changed += 1;
      },
      window,
    });

    try {
      window.history.pushState({}, "", `?gsb-navigation=${String(Date.now())}`);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 350);
      });
      expect(changed).toBe(1);

      document.body.append(document.createElement("div"));
      await Promise.resolve();
      expect(changed).toBe(1);
    } finally {
      stop();
      window.history.replaceState({}, "", originalUrl);
    }
  });

  it("defers one owned route until adoption and rejects the next navigation", async () => {
    const originalUrl = window.location.href;
    let ownedAnchorConfirmed = false;
    let changed = 0;
    const decisions: string[] = [];
    const stop = observeDocumentNavigation({
      decideChange: (_previousUrl, nextUrl) => {
        if (nextUrl.includes("gsb-owned-route")) {
          const decision = ownedAnchorConfirmed ? "adopt" : "defer";
          decisions.push(decision);
          return decision;
        }
        decisions.push("reject");
        return "reject";
      },
      document,
      onChanged: () => {
        changed += 1;
      },
      window,
    });

    try {
      window.history.pushState({}, "", "?gsb-owned-route");
      document.body.append(document.createElement("div"));
      await Promise.resolve();
      expect(decisions).toContain("defer");
      expect(changed).toBe(0);

      ownedAnchorConfirmed = true;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 350);
      });
      expect(decisions).toContain("adopt");
      expect(changed).toBe(0);

      window.history.pushState({}, "", "?gsb-unowned-route");
      document.body.append(document.createElement("div"));
      await Promise.resolve();
      expect(changed).toBe(1);
      expect(decisions.at(-1)).toBe("reject");
    } finally {
      stop();
      window.history.replaceState({}, "", originalUrl);
    }
  });
});
