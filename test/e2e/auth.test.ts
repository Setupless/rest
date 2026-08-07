import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("stock API-key authentication", () => {
  const server = useE2EServer();

  it("[auth-api-key] accepts exactly the configured bearer credential", async () => {
    const missing = await fetch(`${server.origin}/tasks`);
    const malformed = await fetch(`${server.origin}/tasks`, {
      headers: { Authorization: "Basic e2e-api-key-canary" },
    });
    const incorrect = await fetch(`${server.origin}/tasks`, {
      headers: { Authorization: "Bearer incorrect" },
    });
    const allowed = await server.request("/tasks?select=id&order=id.asc");

    expect(missing.status).toBe(401);
    await expectErrorCode(missing, "SLREST300");
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expectErrorCode(malformed, "SLREST300");
    await expectErrorCode(incorrect, "SLREST301");
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const output = JSON.stringify(server.diagnostics());
    expect(output).not.toContain("e2e-api-key-canary");
    expect(output).not.toContain("incorrect");
    expect(output).not.toContain("Authorization");
  });
});

describe("programmatic authorization plugin", () => {
  const server = useE2EServer({ entrypoint: "auth-plugin" });
  const headers = { "X-E2E-Auth": "allow" };

  it("[auth-using] ANDs policy filters with client filters", async () => {
    const response = await server.request(
      "/tasks?or=(project_id.eq.11,id.eq.1)&select=id,project_id&order=id.asc",
      { headers },
    );

    expect(await response.json()).toEqual([{ id: 1, project_id: 10 }]);
  });

  it("[auth-relations] authorizes targets and junctions separately", async () => {
    const response = await server.request(
      "/tasks?id=eq.1&select=id,project:projects(id),tags(id,label)",
      { headers },
    );

    expect(await response.json()).toEqual([
      { id: 1, project: { id: 10 }, tags: [{ id: 20, label: "docs" }] },
    ]);
  });

  it("[auth-check] rejects disallowed post-images and rolls back", async () => {
    const denied = await server.request("/tasks", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Prefer: "missing=default, return=representation",
      },
      body: JSON.stringify({
        id: 40,
        project_id: 10,
        title: "Denied post-image",
        priority: 6,
      }),
    });
    const absent = await server.request("/tasks?id=eq.40", { headers });

    expect(denied.status).toBe(403);
    await expectErrorCode(denied, "SLREST405");
    expect(await absent.json()).toEqual([]);
  });

  it("[auth-denial] fails closed for denials and thrown plugin errors", async () => {
    const denied = await server.request("/tasks", {
      headers: { "X-E2E-Auth": "deny" },
    });
    const unauthorized = await server.request("/tasks", {
      headers: { "X-E2E-Auth": "deny-401" },
    });
    const thrown = await server.request("/tasks", {
      headers: { "X-E2E-Auth": "throw" },
    });
    const thrownText = await thrown.clone().text();

    await expectErrorCode(denied, "SLREST303");
    await expectErrorCode(unauthorized, "SLREST302");
    expect(unauthorized.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expectErrorCode(thrown, "SLREST304");
    expect(thrownText).not.toContain("plugin-secret-must-never-escape");
    expect(JSON.stringify(server.diagnostics())).not.toContain(
      "plugin-secret-must-never-escape",
    );
  });

  it("[auth-openapi] marks plugin security as application-defined", async () => {
    const response = await server.request("/");
    const document = (await response.json()) as Record<string, unknown>;
    const extension = document["x-setupless-rest-authorization"] as Record<
      string,
      unknown
    >;

    expect(extension.mode).toBe("programmatic");
    expect(extension.openapiSecurityAuthoritative).toBe(false);
    expect(
      (document.components as { securitySchemes?: unknown }).securitySchemes,
    ).toBeUndefined();
  });
});
