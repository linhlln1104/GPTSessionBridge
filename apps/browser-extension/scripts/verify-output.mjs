import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const outputRoot = resolve(import.meta.dirname, "../dist");
const dynamicCodePattern = /\b(?:eval|Function)\s*\(/u;
const contentScriptPath = resolve(outputRoot, "content/content-script.js");
const contentScriptLimitBytes = 512 * 1024;
const contentScriptModulePattern = /^\s*(?:export|import)\b/mu;
const forbiddenExtensionCapabilityPattern =
  /\b(?:EventSource|WebSocket|XMLHttpRequest|fetch)\b|\b(?:indexedDB|localStorage|sessionStorage)\b|\b(?:chrome\.cookies|chrome\.storage|document\.cookie)\b/u;

for (const file of await listJavaScriptFiles(outputRoot)) {
  const source = await readFile(file, "utf8");
  if (dynamicCodePattern.test(source)) {
    throw new Error("The extension build contains forbidden dynamic code.");
  }
  if (forbiddenExtensionCapabilityPattern.test(source)) {
    throw new Error("The extension build contains a forbidden network, cookie, or storage API.");
  }
}

const contentScript = await readFile(contentScriptPath, "utf8");
if (
  Buffer.byteLength(contentScript, "utf8") > contentScriptLimitBytes ||
  contentScriptModulePattern.test(contentScript)
) {
  throw new Error("The isolated content-script bundle violates its reviewed capability boundary.");
}

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".js") {
      files.push(path);
    }
  }
  return files;
}
