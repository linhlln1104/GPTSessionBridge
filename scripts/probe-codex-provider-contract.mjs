import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_DIAGNOSTIC_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_ARGUMENTS = '{"cmd":"Write-Output contract-probe"}';
const probeToolRounds = readProbeToolRounds(process.env.GPTSESSIONBRIDGE_PROBE_TOOL_ROUNDS);
const validateProjection = process.env.GPTSESSIONBRIDGE_VALIDATE_V2_PROJECTION === "1";
const projectors = validateProjection ? await loadProjectors() : undefined;
let providerRequestCount = 0;
let firstHeaderDigests;
let projectionBinding;
let childDiagnosticBytes = 0;

const server = createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (request.method !== "POST" || rawBody.length === 0) {
      process.stderr.write(
        `Ignoring ${String(request.method)} ${String(request.url)} during probe.\n`,
      );
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not available", type: "not_found" } }));
      return;
    }
    try {
      const body = JSON.parse(rawBody);
      providerRequestCount += 1;
      process.stdout.write(
        `${JSON.stringify({ index: providerRequestCount, ...summarizeRequest(request, body) }, null, 2)}\n`,
      );
      if (providerRequestCount <= probeToolRounds) {
        writeToolCallResponse(response, body, providerRequestCount);
        return;
      }
    } catch {
      process.stderr.write("Unable to summarize provider request.\n");
    }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "contract probe complete", type: "invalid_request_error" },
      }),
    );
    finish(0);
  });
});

let child;
let finished = false;
let timeout;

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    finish(1);
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const executable = process.env.GPTSESSIONBRIDGE_CODEX_EXECUTABLE ?? "codex";
  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-s",
    "read-only",
    "-m",
    "probe-model",
    "-c",
    'model_provider="contract_probe"',
    "-c",
    'model_providers.contract_probe.name="Contract probe"',
    "-c",
    `model_providers.contract_probe.base_url="${baseUrl}"`,
    "-c",
    'model_providers.contract_probe.wire_api="responses"',
    "-c",
    "model_providers.contract_probe.requires_openai_auth=false",
    "-c",
    "model_providers.contract_probe.request_max_retries=0",
    "-c",
    "model_providers.contract_probe.stream_max_retries=0",
    "Inspect the workspace and return a one-line acknowledgement.",
  ];
  child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (value) => {
    childDiagnosticBytes = Math.min(
      MAX_CHILD_DIAGNOSTIC_BYTES + 1,
      childDiagnosticBytes + value.byteLength,
    );
  });
  child.once("error", () => {
    process.stderr.write("Unable to launch Codex.\n");
    finish(1);
  });
  child.once("exit", (code) => {
    if (!finished) {
      const diagnosticState =
        childDiagnosticBytes === 0
          ? "none"
          : childDiagnosticBytes > MAX_CHILD_DIAGNOSTIC_BYTES
            ? "truncated"
            : "present";
      process.stderr.write(
        `Codex exited before a provider request (code ${String(code)}; diagnostics ${diagnosticState}).\n`,
      );
      finish(1);
    }
  });
  timeout = setTimeout(() => {
    process.stderr.write("Timed out waiting for a provider request.\n");
    finish(1);
  }, REQUEST_TIMEOUT_MS);
});

function summarizeRequest(request, body) {
  return {
    body: summarizeBody(body),
    headers: summarizeHeaders(request.headers),
    method: request.method,
    path: request.url,
    ...(projectors === undefined ? {} : { projection: summarizeProjection(projectors, body) }),
  };
}

function summarizeBody(value) {
  if (!isRecord(value)) {
    return { bodyType: typeof value };
  }
  const input = Array.isArray(value.input) ? value.input : [];
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const functionTools = tools.filter((tool) => isRecord(tool) && tool.type === "function");
  return {
    bodyBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    functionToolsBytes: Buffer.byteLength(JSON.stringify(functionTools), "utf8"),
    input: input.map(summarizeInputItem),
    instructions: summarizeText(value.instructions),
    keys: Object.keys(value).sort(),
    model: typeof value.model === "string" ? value.model : typeof value.model,
    parallelToolCalls: value.parallel_tool_calls,
    reasoning: isRecord(value.reasoning) ? summarizeRecord(value.reasoning) : value.reasoning,
    store: value.store,
    stream: value.stream,
    toolChoice: summarizeRecord(value.tool_choice),
    tools: tools.map(summarizeTool),
    toolsBytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
  };
}

function summarizeHeaders(headers) {
  const selected = ["session-id", "thread-id", "x-client-request-id", "x-codex-turn-metadata"];
  const summarized = Object.fromEntries(
    selected.map((name) => {
      const value = headers[name];
      const digest =
        typeof value === "string"
          ? createHash("sha256").update(value, "utf8").digest("hex")
          : undefined;
      return [
        name,
        typeof value === "string"
          ? {
              bytes: Buffer.byteLength(value, "utf8"),
              digest,
              present: true,
              ...(firstHeaderDigests === undefined
                ? {}
                : { sameAsFirst: firstHeaderDigests[name] === digest }),
            }
          : { present: false },
      ];
    }),
  );
  firstHeaderDigests ??= Object.fromEntries(
    selected.map((name) => [name, summarized[name]?.digest]),
  );
  return summarized;
}

function summarizeProjection(projectorSet, body) {
  if (providerRequestCount > 1) {
    if (projectionBinding === undefined) {
      return { errorCode: "missing_initial_binding", ok: false };
    }
    const continuation = projectorSet.projectContinuation(body, projectionBinding, {
      defaultReasoningEffort: "medium",
    });
    if (continuation.ok) {
      projectionBinding = {
        fingerprint: continuation.value.fingerprint,
        historyFingerprint: continuation.value.historyFingerprint,
      };
    }
    return continuation.ok
      ? {
          kind: continuation.value.kind,
          ok: true,
          projectedBytes: Buffer.byteLength(continuation.value.canonicalBody, "utf8"),
        }
      : { errorCode: continuation.error.code, ok: false };
  }
  const result = projectorSet.projectInitial(body);
  const direct = result.ok
    ? {
        functionTools: result.value.profile.tools.map((tool) => tool.name),
        manifestDigest: result.value.profile.manifestDigest,
        ok: true,
        profileVersion: result.value.profile.profileVersion,
        projectedBytes: Buffer.byteLength(result.value.canonicalBody, "utf8"),
      }
    : { errorCode: result.error.code, ok: false };
  if (result.ok) {
    projectionBinding = {
      fingerprint: result.value.fingerprint,
      historyFingerprint: result.value.historyFingerprint,
    };
  }
  if (result.ok || !isRecord(body.reasoning) || typeof body.reasoning.effort === "string") {
    return direct;
  }
  const withDefaultEffort = projectorSet.projectInitial(body, {
    defaultReasoningEffort: "medium",
  });
  if (withDefaultEffort.ok) {
    projectionBinding = {
      fingerprint: withDefaultEffort.value.fingerprint,
      historyFingerprint: withDefaultEffort.value.historyFingerprint,
    };
  }
  return {
    ...direct,
    diagnosticWithDefaultEffort: withDefaultEffort.ok
      ? { functionTools: withDefaultEffort.value.profile.tools.map((tool) => tool.name), ok: true }
      : { errorCode: withDefaultEffort.error.code, ok: false },
  };
}

async function loadProjectors() {
  try {
    const module = await import("../apps/bridge/dist/http/codex-responses-v2-contract.js");
    if (
      typeof module.projectCodexResponsesV2Initial !== "function" ||
      typeof module.projectCodexResponsesV2Continuation !== "function"
    ) {
      throw new TypeError("projector exports are unavailable");
    }
    return {
      projectContinuation: module.projectCodexResponsesV2Continuation,
      projectInitial: module.projectCodexResponsesV2Initial,
    };
  } catch {
    process.stderr.write("Unable to load the built Responses v2 projector.\n");
    process.exitCode = 1;
    return undefined;
  }
}

function summarizeInputItem(value) {
  if (!isRecord(value)) {
    return { type: typeof value };
  }
  const content = Array.isArray(value.content) ? value.content : undefined;
  return {
    arguments: summarizeText(value.arguments),
    callId: value.call_id,
    keys: Object.keys(value).sort(),
    name: value.name,
    output: summarizeText(value.output),
    role: value.role,
    type: value.type,
    ...(content === undefined
      ? {}
      : {
          content: content.map((part) =>
            isRecord(part)
              ? { keys: Object.keys(part).sort(), text: summarizeText(part.text), type: part.type }
              : { type: typeof part },
          ),
        }),
  };
}

function writeToolCallResponse(response, requestBody, round) {
  const createdAt = Math.floor(Date.now() / 1000);
  const suffix = String(round).padStart(16, "0");
  const callId = `call_contractprobe${suffix}`;
  const itemId = `fc_contractprobe${suffix}`;
  const responseId = `resp_contractprobe${suffix}`;
  const completedCall = {
    arguments: PROBE_ARGUMENTS,
    call_id: callId,
    id: itemId,
    name: "exec_command",
    status: "completed",
    type: "function_call",
  };
  const pendingCall = { ...completedCall, arguments: "", status: "in_progress" };
  const progress = responseObject(requestBody, responseId, createdAt, "in_progress", []);
  const completed = responseObject(requestBody, responseId, createdAt, "completed", [
    completedCall,
  ]);
  const events = [
    ["response.created", { response: progress, type: "response.created" }],
    ["response.in_progress", { response: progress, type: "response.in_progress" }],
    [
      "response.output_item.added",
      {
        item: pendingCall,
        output_index: 0,
        response_id: responseId,
        type: "response.output_item.added",
      },
    ],
    [
      "response.function_call_arguments.delta",
      {
        delta: PROBE_ARGUMENTS,
        item_id: itemId,
        output_index: 0,
        response_id: responseId,
        type: "response.function_call_arguments.delta",
      },
    ],
    [
      "response.function_call_arguments.done",
      {
        arguments: PROBE_ARGUMENTS,
        item_id: itemId,
        name: "exec_command",
        output_index: 0,
        response_id: responseId,
        type: "response.function_call_arguments.done",
      },
    ],
    [
      "response.output_item.done",
      {
        item: completedCall,
        output_index: 0,
        response_id: responseId,
        type: "response.output_item.done",
      },
    ],
    ["response.completed", { response: completed, type: "response.completed" }],
  ];
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  events.forEach(([event, data], sequenceNumber) => {
    response.write(
      `event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: sequenceNumber })}\n\n`,
    );
  });
  response.end();
}

function responseObject(requestBody, responseId, createdAt, status, output) {
  return {
    completed_at: status === "completed" ? createdAt : null,
    created_at: createdAt,
    error: null,
    id: responseId,
    incomplete_details: null,
    instructions: requestBody.instructions ?? null,
    max_output_tokens: null,
    metadata: {},
    model: requestBody.model,
    object: "response",
    output,
    parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    status,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: requestBody.tools ?? [],
    top_p: null,
    truncation: "disabled",
    usage: null,
  };
}

function summarizeTool(value) {
  if (!isRecord(value)) {
    return { type: typeof value };
  }
  const schema = value.parameters ?? value.input_schema;
  return {
    keys: Object.keys(value).sort(),
    name: value.name,
    schema: summarizeSchema(schema),
    type: value.type,
  };
}

function summarizeSchema(value) {
  if (value === undefined) {
    return undefined;
  }
  const canonical = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(canonical, "utf8"),
    digest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    keys: isRecord(value) ? Object.keys(value).sort() : [],
  };
}

function summarizeRecord(value) {
  return isRecord(value) ? { keys: Object.keys(value).sort() } : value;
}

function summarizeText(value) {
  if (typeof value !== "string") {
    return value === undefined ? undefined : { type: typeof value };
  }
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    digest: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProbeToolRounds(value) {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new RangeError("GPTSESSIONBRIDGE_PROBE_TOOL_ROUNDS must be an integer from 1 to 3.");
  }
  return parsed;
}

function finish(code) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  server.close();
  if (child !== undefined && child.exitCode === null) {
    child.kill();
  }
  process.exitCode = code;
}
