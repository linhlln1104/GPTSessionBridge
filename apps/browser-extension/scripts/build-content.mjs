import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

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

const source = await readFile(inputFile, "utf8");
const result = ts.transpileModule(source, {
  compilerOptions: {
    ignoreDeprecations: "6.0",
    module: ts.ModuleKind.None,
    moduleDetection: ts.ModuleDetectionKind.Legacy,
    sourceMap: false,
    target: ts.ScriptTarget.ES2024,
  },
  fileName: inputFile,
  reportDiagnostics: true,
});

if ((result.diagnostics?.length ?? 0) > 0 || /^\s*(?:export|import)\b/mu.test(result.outputText)) {
  throw new Error("The content script did not compile as a self-contained classic script.");
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, result.outputText, "utf8");
