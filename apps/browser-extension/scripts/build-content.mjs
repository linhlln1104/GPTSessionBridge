import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputFile = resolve(appRoot, "src/content/content-script.ts");
const outputDirectory = resolve(appRoot, "dist/content");
const outputFile = resolve(outputDirectory, "content-script.js");

if (
  dirname(outputDirectory) !== resolve(appRoot, "dist") ||
  dirname(outputFile) !== outputDirectory
) {
  throw new Error("Refusing to write to an unexpected content-script output path.");
}

await build({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: outputDirectory,
    rollupOptions: {
      input: inputFile,
      output: {
        entryFileNames: "content-script.js",
        format: "iife",
      },
    },
    sourcemap: false,
    target: "chrome106",
  },
  configFile: false,
  logLevel: "warn",
  publicDir: false,
});

const source = await readFile(outputFile, "utf8");
if (/^\s*(?:export|import)\b/mu.test(source)) {
  throw new Error("The content script did not bundle as a self-contained classic script.");
}
