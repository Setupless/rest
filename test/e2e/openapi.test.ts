import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box API discovery", () => {
  const server = useE2EServer({ maxRows: 42, maxEmbedDepth: 3 });

  it("[openapi-root] serves deterministic schema-derived OpenAPI", async () => {
    const response = await server.request("/", {
      headers: { Accept: "application/openapi+json" },
    });
    const document = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
      components: {
        schemas: Record<string, unknown>;
        securitySchemes: Record<string, unknown>;
      };
      "x-setupless-rest": Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/openapi+json; charset=utf-8",
    );
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toMatchObject({
      title: "Setupless/rest",
      version: "0.1.0",
    });
    expect(Object.keys(document.paths["/tasks"] ?? {})).toEqual([
      "get",
      "head",
      "options",
      "post",
      "patch",
      "delete",
      "put",
    ]);
    expect(Object.keys(document.paths["/open_tasks"] ?? {})).toEqual([
      "get",
      "head",
      "options",
    ]);
    expect(document.components.schemas.SLRESTError).toBeDefined();
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(document["x-setupless-rest"]).toMatchObject({
      database: "sqlite",
      compatibility: "postgrest-inspired",
      schemaRefresh: "restart-required",
      maxRows: 42,
      maxEmbedDepth: 3,
    });
    expect(JSON.stringify(document)).not.toContain("e2e-api-key-canary");
  });

  it("[openapi-negotiation] supports JSON and rejects unsupported media", async () => {
    const json = await server.request("/", {
      headers: { Accept: "application/json" },
    });
    const unsupported = await server.request("/", {
      headers: { Accept: "text/csv" },
    });

    expect(json.status).toBe(200);
    expect(json.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect((await json.json()) as { openapi: string }).toMatchObject({
      openapi: "3.1.0",
    });
    await expectErrorCode(unsupported, "SLREST105");
  });
});
