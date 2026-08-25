import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createLocalhostPolicy,
  evaluateLocalRequest,
  LOOPBACK_IPV4_ADDRESS,
  type CapabilityToken,
  verifyCapabilityToken,
} from "@gpt-session-bridge/core/security";

export const SESSION_NOT_CONNECTED_CODE = "session_not_connected" as const;

export interface ResponsesStubOptions {
  readonly headerTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxConnections: number;
  readonly requestTimeoutMs: number;
  readonly token: CapabilityToken;
}

export interface ResponsesStubAddress {
  readonly baseUrl: string;
  readonly port: number;
}

export class ResponsesStubServer {
  readonly #options: ResponsesStubOptions;
  #address: ResponsesStubAddress | undefined;
  #server: Server | undefined;

  public constructor(options: ResponsesStubOptions) {
    if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
      throw new RangeError("Invalid body limit");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new RangeError("Invalid request timeout");
    }
    if (!Number.isSafeInteger(options.headerTimeoutMs) || options.headerTimeoutMs < 1) {
      throw new RangeError("Invalid header timeout");
    }
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) {
      throw new RangeError("Invalid connection limit");
    }
    this.#options = options;
  }

  public get address(): ResponsesStubAddress {
    if (this.#address === undefined) {
      throw new Error("Responses stub is not listening");
    }
    return this.#address;
  }

  public async start(): Promise<ResponsesStubAddress> {
    if (this.#server !== undefined) {
      throw new Error("Responses stub is already started");
    }

    const server = createServer((request, response) => {
      request.socket.setTimeout(this.#options.requestTimeoutMs);
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) {
          writeError(response, 500, "internal_error", "Local provider request failed.");
        } else {
          response.destroy();
        }
      });
    });
    server.headersTimeout = this.#options.headerTimeoutMs;
    server.keepAliveTimeout = this.#options.headerTimeoutMs;
    server.maxConnections = this.#options.maxConnections;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 1;
    server.requestTimeout = this.#options.requestTimeoutMs;
    server.on("connection", (socket) => {
      socket.setTimeout(this.#options.headerTimeoutMs, () => {
        socket.destroy();
      });
    });
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK_IPV4_ADDRESS, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch {
      this.#server = undefined;
      throw new Error("Responses stub failed to bind");
    }

    const boundAddress = server.address();
    if (boundAddress === null || typeof boundAddress === "string") {
      await this.close();
      throw new Error("Responses stub failed to bind");
    }
    this.#address = Object.freeze({
      baseUrl: `http://${LOOPBACK_IPV4_ADDRESS}:${String(boundAddress.port)}/v1`,
      port: boundAddress.port,
    });
    return this.#address;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");

    const policy = createLocalhostPolicy(this.address.port);
    const localDecision = evaluateLocalRequest(policy, {
      host: request.headers.host,
      origin: request.headers.origin,
    });
    if (!localDecision.allowed) {
      request.resume();
      writeError(response, 403, "request_rejected", "Local request rejected.");
      return;
    }

    if (!verifyCapabilityToken(readBearerToken(request), this.#options.token)) {
      request.resume();
      response.setHeader("WWW-Authenticate", "Bearer");
      writeError(response, 401, "invalid_capability", "Capability token required.");
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/responses") {
      request.resume();
      writeError(response, 404, "not_found", "Route not found.");
      return;
    }

    const declaredLength = readContentLength(request);
    if (declaredLength === "invalid") {
      request.resume();
      writeError(response, 400, "invalid_request", "Content-Length is invalid.");
      return;
    }
    if (declaredLength !== undefined && declaredLength > this.#options.maxBodyBytes) {
      request.resume();
      writeError(response, 413, "request_too_large", "Request body is too large.");
      return;
    }

    const body = await readBoundedBody(request, this.#options.maxBodyBytes);
    if (body === undefined) {
      writeError(response, 413, "request_too_large", "Request body is too large.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Invalid request body");
      }
    } catch {
      writeError(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }

    writeError(
      response,
      503,
      SESSION_NOT_CONNECTED_CODE,
      "No explicitly connected ChatGPT Web tab is available.",
    );
  }
}

function readContentLength(request: IncomingMessage): number | "invalid" | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return "invalid";
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : "invalid";
}

function readBearerToken(request: IncomingMessage): unknown {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 && !token.includes(" ") ? token : undefined;
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;
    if (buffer === undefined) {
      throw new TypeError("Invalid request chunk");
    }
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBodyBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, receivedBytes);
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  response.statusCode = status;
  response.end(JSON.stringify({ error: { code, message, type: "bridge_error" } }));
}
