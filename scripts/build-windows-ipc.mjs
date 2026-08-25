import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const project = fileURLToPath(
    new URL(
      "../native/windows-ipc/src/GPTSessionBridge.WindowsIpc/GPTSessionBridge.WindowsIpc.csproj",
      import.meta.url,
    ),
  );
  const output = fileURLToPath(new URL("../native/windows-ipc/artifacts/win-x64", import.meta.url));
  runDotnet([
    "publish",
    project,
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    "-o",
    output,
  ]);
}

function runDotnet(args) {
  const result = spawnSync("dotnet", args, {
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error("The Windows IPC helper build could not start.", { cause: result.error });
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
