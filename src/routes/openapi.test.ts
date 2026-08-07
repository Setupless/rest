import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createRestApp } from "../app";
import { createApiKeyAuth } from "../auth/api-key";
import { loadDatabaseSchema } from "../database/schema";

const databases: Database[] = [];

function createApp(secret = "test-secret", maxRows = 1000, maxEmbedDepth = 5) {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  return createRestApp({
    database,
    schema: loadDatabaseSchema(database),
    auth: createApiKeyAuth(secret),
    maxRows,
    maxEmbedDepth,
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("API root", () => {
  it.each([
    [undefined, "application/openapi+json; charset=utf-8"],
    ["*/*", "application/openapi+json; charset=utf-8"],
    ["application/json", "application/json; charset=utf-8"],
    ["application/openapi+json", "application/openapi+json; charset=utf-8"],
  ])("negotiates %p as %s", async (accept, contentType) => {
    const app = createApp();
    const response = await app.handle(
      new Request("http://localhost/", {
        headers: accept === undefined ? undefined : { Accept: accept },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(await response.json()).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Setupless/rest", version: "0.1.0" },
    });
  });

  it("supports HEAD and OPTIONS without a document body", async () => {
    const app = createApp();
    const head = await app.handle(
      new Request("http://localhost/", { method: "HEAD" }),
    );
    const options = await app.handle(
      new Request("http://localhost/", { method: "OPTIONS" }),
    );

    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(
      "application/openapi+json; charset=utf-8",
    );
    expect(await head.text()).toBe("");
    expect(options.status).toBe(204);
    expect(options.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(await options.text()).toBe("");
  });

  it("uses stable errors for unsupported media, preferences, and methods", async () => {
    const app = createApp();
    const media = await app.handle(
      new Request("http://localhost/", {
        headers: { Accept: "application/vnd.pgrst.object+json" },
      }),
    );
    const preference = await app.handle(
      new Request("http://localhost/", {
        headers: { Prefer: "return=representation, handling=strict" },
      }),
    );
    const method = await app.handle(
      new Request("http://localhost/", { method: "POST" }),
    );

    expect(media.status).toBe(415);
    expect(await media.json()).toMatchObject({ code: "SLREST105" });
    expect(preference.status).toBe(400);
    expect(await preference.json()).toMatchObject({ code: "SLREST104" });
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(await method.json()).toMatchObject({ code: "SLREST204" });
  });

  it("echoes valid request IDs and never exposes the configured key", async () => {
    const secret = "canary-secret-never-emit";
    const app = createApp(secret);
    const response = await app.handle(
      new Request("http://localhost/", {
        headers: { "X-Request-Id": "request.root-1" },
      }),
    );
    const body = await response.text();

    expect(response.headers.get("X-Request-Id")).toBe("request.root-1");
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)["x-setupless-rest-authorization"]).toMatchObject({
      mode: "api-key",
    });
  });

  it("describes the configured query limits", async () => {
    const app = createApp("test-secret", 37, 2);
    const response = await app.handle(new Request("http://localhost/"));

    expect(JSON.parse(await response.text())["x-setupless-rest"]).toMatchObject(
      {
        database: "sqlite",
        compatibility: "postgrest-inspired",
        schemaRefresh: "restart-required",
        maxRows: 37,
        maxEmbedDepth: 2,
      },
    );
  });
});
