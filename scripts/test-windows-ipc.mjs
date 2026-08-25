import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const solution = fileURLToPath(
    new URL("../native/windows-ipc/GPTSessionBridge.WindowsIpc.slnx", import.meta.url),
  );
  runDotnet(["build", solution, "-c", "Release"]);
  runDotnet(["test", solution, "-c", "Release", "--no-build"]);
  runDotnet(["format", solution, "--verify-no-changes", "--no-restore"]);
  runDotnet(["list", solution, "package", "--vulnerable", "--include-transitive"]);
}

function runDotnet(args) {
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    return;
  }
  const result = spawnSync("dotnet", args, {
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error("The Windows IPC helper verification could not start.", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
