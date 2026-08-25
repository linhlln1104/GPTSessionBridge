import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(appRoot, "dist");

if (dirname(outputDirectory) !== appRoot) {
  throw new Error("Refusing to clean an unexpected Native Host output directory.");
}

await rm(outputDirectory, { force: true, recursive: true });
