import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright({
        launchOptions: { channel: "chrome" },
      }),
      ui: false,
    },
    fileParallelism: false,
    include: ["browser-test/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
