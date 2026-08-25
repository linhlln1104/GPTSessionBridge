import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(packageRoot, "dist");

if (dirname(outputRoot) !== packageRoot) {
  throw new Error("Refusing to clean an unexpected setup output directory.");
}

await rm(outputRoot, { force: true, recursive: true });
