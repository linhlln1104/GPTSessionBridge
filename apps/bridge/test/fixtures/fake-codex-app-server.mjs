import { createInterface } from "node:readline";

const providerPrefix = "model_providers.gptsessionbridge_web";
const largeResumePayload = "x".repeat(2 * 1024 * 1024);
const lines = createInterface({ input: process.stdin, terminal: false });

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request === null || typeof request !== "object" || !("id" in request)) {
    return;
  }

  if (request.method === "initialize") {
    respond(request.id, { userAgent: "synthetic-app-server" });
    return;
  }
  if (request.method === "model/list") {
    respond(request.id, {
      data: [{ id: "native-model", isDefault: true, model: "native-model" }],
    });
    return;
  }
  if (request.method === "thread/start") {
    const config = request.params?.config;
    const capability = config?.[`${providerPrefix}.experimental_bearer_token`];
    const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase());
    respond(request.id, {
      capabilityInEnvironment: Object.values(process.env).includes(capability),
      loopbackProxyBypassConfigured: ["localhost", "127.0.0.1", "::1"].every((entry) =>
        noProxy.includes(entry),
      ),
      model: request.params?.model,
      modelProvider: request.params?.modelProvider,
      providerConfigured: typeof capability === "string" && capability.startsWith("gsb_"),
      preexistingProxyBypassPreserved: noProxy.includes("corp.example"),
      proxyRespectDisabled: config?.["features.respect_system_proxy"] === false,
      reasoningEffort: config?.model_reasoning_effort,
      thread: { id: "synthetic-thread", modelProvider: request.params?.modelProvider },
      unexpectedBridgeControlEnvironment: Object.keys(process.env).some(
        (key) =>
          key.toUpperCase().startsWith("GPTSESSIONBRIDGE_") &&
          key.toUpperCase() !== "GPTSESSIONBRIDGE_ACTIVE",
      ),
    });
    return;
  }
  if (request.method === "thread/resume") {
    respond(request.id, {
      largeResumePayload,
      model: "native-model",
      modelProvider: "native-provider",
      reasoningEffort: "medium",
      thread: { id: request.params?.threadId, modelProvider: "native-provider" },
    });
    return;
  }

  respond(request.id, {});
});

process.stderr.write("synthetic child diagnostic\n");

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
