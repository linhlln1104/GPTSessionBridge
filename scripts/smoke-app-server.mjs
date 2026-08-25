import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const SYNTHETIC_MODEL_ID = "gptsessionbridge/web/example-model";
const bridgeCli = fileURLToPath(new URL("../apps/bridge/dist/cli.js", import.meta.url));

async function main() {
  const child = spawn(process.execPath, [bridgeCli, "app-server"], {
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = Buffer.alloc(0);
  let outputBytes = 0;
  let stderrBytes = 0;
  let nextRequestId = 1;
  let shuttingDown = false;
  let terminalError;
  let smokeSummary;
  const pending = new Map();

  const fail = (error) => {
    if (terminalError !== undefined) {
      return;
    }
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const abort = (error) => {
    fail(error);
    if (!hasExited(child)) {
      child.kill();
    }
  };

  child.once("error", () => {
    abort(new Error("child startup failed"));
  });
  child.once("exit", () => {
    if (!shuttingDown || pending.size > 0) {
      fail(new Error("child exited before completing the smoke test"));
    }
  });
  child.stdin.on("error", () => {
    abort(new Error("child input stream failed"));
  });
  child.stdout.on("error", () => {
    abort(new Error("child output stream failed"));
  });
  child.stdout.once("end", () => {
    if (buffered.length > 0) {
      fail(new Error("child emitted an incomplete protocol frame"));
    }
    if (!shuttingDown || pending.size > 0) {
      fail(new Error("child output ended before completing the smoke test"));
    }
  });
  child.stderr.on("error", () => {
    abort(new Error("child error stream failed"));
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + Buffer.byteLength(chunk));
  });
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      abort(new Error("child output exceeded the smoke-test limit"));
      return;
    }
    buffered =
      buffered.length === 0
        ? bytes
        : Buffer.concat([buffered, bytes], buffered.length + bytes.length);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      let lineBytes = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d) {
        lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
      }
      let envelope;
      try {
        const line = decoder.decode(lineBytes);
        envelope = JSON.parse(line);
      } catch {
        abort(new Error("child emitted an invalid protocol frame"));
        return;
      }
      if (!isRecord(envelope) || !("id" in envelope)) {
        continue;
      }
      const request = pending.get(envelope.id);
      if (request === undefined) {
        continue;
      }
      pending.delete(envelope.id);
      clearTimeout(request.timer);
      if ("error" in envelope) {
        request.reject(new Error("app-server request failed"));
      } else {
        request.resolve(envelope);
      }
    }
  });

  const writeEnvelope = async (envelope) => {
    if (terminalError !== undefined) {
      throw terminalError;
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("child input stream is unavailable");
    }
    try {
      await writeToChild(child.stdin, `${JSON.stringify(envelope)}\n`);
    } catch {
      const error = new Error("child input stream failed");
      abort(error);
      throw error;
    }
    if (terminalError !== undefined) {
      throw terminalError;
    }
  };

  const request = async (method, params) => {
    const id = nextRequestId;
    nextRequestId += 1;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("app-server request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { reject, resolve, timer });
    });
    void response.catch(() => undefined);
    await writeEnvelope({ id, method, params });
    return response;
  };

  try {
    await request("initialize", {
      capabilities: null,
      clientInfo: {
        name: "gptsessionbridge_smoke",
        title: "GPTSessionBridge compatibility smoke",
        version: "0.1.0",
      },
    });
    await writeEnvelope({ method: "initialized" });
    const models = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < 32; page += 1) {
      const modelResponse = await request("model/list", {
        ...(cursor === undefined ? {} : { cursor }),
        includeHidden: false,
        limit: 1_000,
      });
      const modelPage = readModelPage(modelResponse);
      models.push(...modelPage.models);
      if (models.length > 4_096) {
        throw new Error("model catalog exceeded the smoke-test limit");
      }
      if (modelPage.nextCursor === null) {
        break;
      }
      if (seenCursors.has(modelPage.nextCursor)) {
        throw new Error("model catalog repeated a cursor");
      }
      seenCursors.add(modelPage.nextCursor);
      cursor = modelPage.nextCursor;
      if (page === 31) {
        throw new Error("model catalog exceeded the smoke-test page limit");
      }
    }
    const webModels = models.filter((model) => model.id === SYNTHETIC_MODEL_ID);
    if (webModels.length !== 1 || !hasCurrentModelContract(webModels[0])) {
      throw new Error("synthetic model contract mismatch");
    }
    smokeSummary = `app-server smoke: ok nativeModels=${models.length - 1} webModels=1 contract=ok stderrBytes=${stderrBytes}\n`;
  } finally {
    shuttingDown = true;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      try {
        child.stdin.end();
      } catch {
        fail(new Error("child input stream failed"));
      }
    }
    await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  }
  if (terminalError !== undefined) {
    throw terminalError;
  }
  process.stdout.write(smokeSummary);
}

function readModelPage(response) {
  if (!isRecord(response) || !isRecord(response.result) || !Array.isArray(response.result.data)) {
    throw new Error("invalid model/list response");
  }
  if (!response.result.data.every(isRecord)) {
    throw new Error("invalid model descriptor");
  }
  const nextCursor = response.result.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new Error("invalid model/list cursor");
  }
  return { models: response.result.data, nextCursor };
}

function hasCurrentModelContract(model) {
  return (
    model.id === SYNTHETIC_MODEL_ID &&
    model.model === SYNTHETIC_MODEL_ID &&
    model.hidden === false &&
    model.isDefault === false &&
    model.upgrade === null &&
    model.upgradeInfo === null &&
    model.availabilityNux === null &&
    model.modelSpecialty === null &&
    model.multiAgentVersion === null &&
    model.defaultServiceTier === null &&
    Array.isArray(model.inputModalities) &&
    model.inputModalities.length === 1 &&
    model.inputModalities[0] === "text" &&
    Array.isArray(model.additionalSpeedTiers) &&
    Array.isArray(model.serviceTiers)
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function writeToChild(stream, frame) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.off("close", onClose);
      stream.off("error", onError);
      callback(value);
    };
    const onClose = () => {
      settle(reject, new Error("child input stream closed"));
    };
    const onError = () => {
      settle(reject, new Error("child input stream failed"));
    };
    stream.once("close", onClose);
    stream.once("error", onError);
    try {
      stream.write(frame, "utf8", (error) => {
        if (error === null || error === undefined) {
          settle(resolve);
        } else {
          settle(reject, new Error("child input stream failed"));
        }
      });
    } catch {
      settle(reject, new Error("child input stream failed"));
    }
  });
}

async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) {
    return;
  }
  if (await waitForExitWithin(child, timeoutMs)) {
    return;
  }
  child.kill();
  if (await waitForExitWithin(child, timeoutMs)) {
    return;
  }
  throw new Error("child failed to stop");
}

async function waitForExitWithin(child, timeoutMs) {
  if (hasExited(child)) {
    return true;
  }
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      child.off("exit", onExit);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(exited);
    };
    const onExit = () => {
      finish(true);
    };
    child.once("exit", onExit);
    if (hasExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => {
      finish(hasExited(child));
    }, timeoutMs);
  });
}

main().catch(() => {
  process.stderr.write("app-server smoke: failed\n");
  process.exitCode = 1;
});
