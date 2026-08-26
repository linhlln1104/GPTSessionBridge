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
});
