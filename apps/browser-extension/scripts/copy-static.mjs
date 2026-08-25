import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(appRoot, "dist");
const popupOutputDirectory = resolve(outputDirectory, "popup");

if (dirname(outputDirectory) !== appRoot || dirname(popupOutputDirectory) !== outputDirectory) {
  throw new Error("Refusing to write to an unexpected output directory.");
}

await mkdir(popupOutputDirectory, { recursive: true });
await Promise.all([
  copyFile(resolve(appRoot, "manifest.json"), resolve(outputDirectory, "manifest.json")),
  copyFile(resolve(appRoot, "src/popup/popup.html"), resolve(popupOutputDirectory, "popup.html")),
  copyFile(resolve(appRoot, "src/popup/popup.css"), resolve(popupOutputDirectory, "popup.css")),
]);
