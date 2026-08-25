import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getWindowsDevelopmentHostStatus,
  installWindowsDevelopmentHost,
  uninstallWindowsDevelopmentHost,
} from "../apps/windows-setup/dist/index.js";

if (process.platform !== "win32" || process.arch !== "x64") {
  process.stdout.write("Windows setup smoke skipped on this platform.\n");
  process.exit(0);
}
if (process.env["GPTSESSIONBRIDGE_ALLOW_REGISTRY_SMOKE"] !== "1") {
  throw new Error("Windows setup smoke requires explicit registry-test opt-in.");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "artifacts/windows-x64");
const initial = await getWindowsDevelopmentHostStatus();
if (initial.state !== "not-installed") {
  throw new Error("Windows setup smoke refuses to replace an existing registration.");
}

let installed = false;
try {
  const result = await installWindowsDevelopmentHost(packageRoot);
  installed = true;
  const status = await getWindowsDevelopmentHostStatus();
  if (status.state !== "installed" || status.packageDigest !== result.packageDigest) {
    throw new Error("Windows setup smoke could not verify the installed registration.");
  }
  const removed = await uninstallWindowsDevelopmentHost();
  installed = false;
  if (
    !removed.unregistered ||
    (await getWindowsDevelopmentHostStatus()).state !== "not-installed"
  ) {
    throw new Error("Windows setup smoke could not verify unregistration.");
  }
  process.stdout.write("Verified per-user Windows development registration.\n");
} finally {
  if (installed) {
    await uninstallWindowsDevelopmentHost().catch(() => undefined);
  }
}
