import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        "background/service-worker": resolve(
          import.meta.dirname,
          "src/background/service-worker.ts",
        ),
        "popup/popup": resolve(import.meta.dirname, "src/popup/popup.ts"),
      },
      output: {
        chunkFileNames: "chunks/[name].js",
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    sourcemap: false,
    target: "chrome106",
  },
  publicDir: false,
});
