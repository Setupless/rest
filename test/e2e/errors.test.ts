import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box stable error families", () => {
  const server = useE2EServer({ maxBodyBytes: 64 });

  it("[error-envelope] returns only the four public error fields", async () => {
    const response = await server.request("/missing", {
      headers: { "X-Request-Id": "error-envelope" },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBe("error-envelope");
    expect(Object.keys(body)).toEqual(["code", "message", "details", "hint"]);
    expect(body.code).toBe("SLREST200");
  });

  it("[error-media] rejects unsupported request and response media", async () => {
    const requestMedia = await server.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json",
    });
    const responseMedia = await server.request("/tasks", {
      headers: { Accept: "text/csv" },
    });

    await expectErrorCode(requestMedia, "SLREST105");
    await expectErrorCode(responseMedia, "SLREST105");
  });

  it("[error-body-limit] rejects oversized bodies before JSON parsing", async () => {
    const response = await server.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(100) }),
    });

    expect(response.status).toBe(413);
    await expectErrorCode(response, "SLREST108");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"title":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const streamed = await server.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expectErrorCode(streamed, "SLREST108");
  });

  it("[error-constraint] maps uniqueness, foreign keys, and invalid payloads", async () => {
    const duplicate = await server.request("/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "missing=default",
      },
      body: JSON.stringify({ id: 1, project_id: 10, title: "Duplicate" }),
    });
    const foreignKey = await server.request("/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "missing=default",
      },
      body: JSON.stringify({ id: 60, project_id: 999, title: "No parent" }),
    });
    const invalid = await server.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    await expectErrorCode(duplicate, "SLREST400");
    await expectErrorCode(foreignKey, "SLREST401");
    await expectErrorCode(invalid, "SLREST107");
  });

  it("[error-redaction] excludes secrets, SQL, paths, and bodies", async () => {
    const canary = "body-secret-canary";
    const response = await server.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: canary }),
    });
    const body = await response.text();
    const diagnostics = JSON.stringify(server.diagnostics());

    expect(body).not.toContain(canary);
    expect(body).not.toContain(server.databasePath);
    expect(body).not.toContain("INSERT");
    expect(diagnostics).not.toContain(canary);
    expect(diagnostics).not.toContain(server.databasePath);
  });
});
