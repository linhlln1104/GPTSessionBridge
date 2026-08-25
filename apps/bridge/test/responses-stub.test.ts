import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { generateCapabilityToken, type CapabilityToken } from "@gpt-session-bridge/core/security";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResponsesStubServer, SESSION_NOT_CONNECTED_CODE } from "../src/http/responses-stub.js";

describe("ResponsesStubServer", () => {
  let server: ResponsesStubServer;
  let token: CapabilityToken;

  beforeEach(async () => {
    token = generateCapabilityToken();
    server = new ResponsesStubServer({
      headerTimeoutMs: 1_000,
      maxBodyBytes: 128,
      maxConnections: 16,
      requestTimeoutMs: 2_000,
      token,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns an explicit disconnected error without reflecting request content", async () => {
    const canary = "private-request-canary";
    const response = await fetch(`${server.address.baseUrl}/responses`, {
      body: JSON.stringify({ input: canary, model: "gptsessionbridge/web/example-model" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: { code: SESSION_NOT_CONNECTED_CODE } });
    expect(body).not.toContain(canary);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the process capability token", async () => {
    const response = await fetch(`${server.address.baseUrl}/responses`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");

    const malformed = await fetch(`${server.address.baseUrl}/responses`, {
      body: "{}",
      headers: {
        authorization: "Bearer invalid token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(401);
  });

  it("rejects an unexpected Host header", async () => {
    const result = await rawRequest(server.address.port, {
      Authorization: `Bearer ${token}`,
      Host: "example.invalid",
    });

    expect(result.status).toBe(403);

    const originRejected = await rawRequest(server.address.port, {
      Authorization: `Bearer ${token}`,
      Host: `127.0.0.1:${String(server.address.port)}`,
      Origin: "https://example.invalid",
    });
    expect(originRejected.status).toBe(403);
  });

  it("rejects malformed, oversized, and unknown requests", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const malformed = await fetch(`${server.address.baseUrl}/responses`, {
      body: "not-json",
      headers,
      method: "POST",
    });
    expect(malformed.status).toBe(400);

    const nonObject = await fetch(`${server.address.baseUrl}/responses`, {
      body: "[]",
      headers,
      method: "POST",
    });
    expect(nonObject.status).toBe(400);

    const oversized = await fetch(`${server.address.baseUrl}/responses`, {
      body: JSON.stringify({ input: "x".repeat(256) }),
      headers,
      method: "POST",
    });
    expect(oversized.status).toBe(413);

    const unknown = await fetch(`${server.address.baseUrl}/unknown`, {
      body: "{}",
      headers,
      method: "POST",
    });
    expect(unknown.status).toBe(404);
  });

  it("supports idempotent shutdown", async () => {
    await server.close();
    await server.close();
  });

  it("stops accepting and closes an incomplete local connection", async () => {
    const socket = connect(server.address.port, "127.0.0.1");
    await once(socket, "connect");
    const closing = server.close();
    await expect(closing).resolves.toBeUndefined();
    socket.destroy();
  });

  it("validates lifecycle and resource limits", async () => {
    await expect(server.start()).rejects.toThrow("already started");

    const baseOptions = {
      headerTimeoutMs: 1_000,
      maxBodyBytes: 128,
      maxConnections: 16,
      requestTimeoutMs: 2_000,
      token,
    };
    for (const options of [
      { ...baseOptions, maxBodyBytes: 0 },
      { ...baseOptions, requestTimeoutMs: 0 },
      { ...baseOptions, headerTimeoutMs: 0 },
      { ...baseOptions, maxConnections: 0 },
    ]) {
      expect(() => new ResponsesStubServer(options)).toThrow(RangeError);
    }

    const idle = new ResponsesStubServer(baseOptions);
    expect(() => idle.address).toThrow("not listening");
    await idle.close();
  });
});

function rawRequest(
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly body: string; readonly status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers,
        host: "127.0.0.1",
        method: "POST",
        path: "/v1/responses",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode });
        });
      },
    );
    request.once("error", reject);
    request.end("{}");
  });
}
