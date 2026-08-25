import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const outputRoot = resolve(import.meta.dirname, "../dist");
const dynamicCodePattern = /\b(?:eval|Function)\s*\(/u;

for (const file of await listJavaScriptFiles(outputRoot)) {
  const source = await readFile(file, "utf8");
  if (dynamicCodePattern.test(source)) {
    throw new Error("The extension build contains forbidden dynamic code.");
  }
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
