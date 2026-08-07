import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../test/fixtures";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import type { Database } from "../database/database";
import { loadDatabaseSchema } from "../database/schema";
import type { RestLogger } from "../logging/logger";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://setupless.test${path}`, init);
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("operational HTTP behavior", () => {
  let testDatabase: TestDatabase;
  let database: Database;

  beforeAll(() => {
    testDatabase = createTestDatabase();
    database = testDatabase.database;
  });

  afterAll(() => cleanupTestDatabase(testDatabase));

  function app(
    options: {
      maxBodyBytes?: number;
      corsOrigins?: readonly string[];
      logger?: RestLogger;
      auth?: RestAuthPlugin;
    } = {},
  ) {
    return createRestApp({
      database,
      schema: loadDatabaseSchema(database),
      ...options,
    });
  }

  it("rejects oversized invalid JSON before payload parsing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{bro"));
        controller.enqueue(new TextEncoder().encode("ken-json"));
        controller.close();
      },
    });
    const response = await app({ maxBodyBytes: 5 }).handle(
      request("/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("SLREST108");
    expect(response.headers.get("X-Request-Id")).not.toBeNull();
  });

  it("allows exact origins and rejects unconfigured actual origins", async () => {
    const configured = app({ corsOrigins: ["https://app.example"] });
    const allowed = await configured.handle(
      request("/users", { headers: { Origin: "https://app.example" } }),
    );
    const denied = await configured.handle(
      request("/users", { headers: { Origin: "https://other.example" } }),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
    expect(allowed.headers.get("Vary")).toContain("Origin");
    expect(allowed.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Request-Id",
    );
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("SLREST305");
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("validates preflight methods and headers against the target resource", async () => {
    const configured = app({ corsOrigins: ["https://app.example"] });
    const preflight = (method: string, headers: string) =>
      configured.handle(
        request("/users", {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example",
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
          },
        }),
      );
    const allowed = await preflight(
      "PATCH",
      "authorization, content-type, prefer",
    );
    const deniedMethod = await preflight("TRACE", "authorization");
    const deniedHeader = await preflight("GET", "x-secret-header");

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toContain(
      "PATCH",
    );
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, Prefer",
    );
    expect(await errorCode(deniedMethod)).toBe("SLREST305");
    expect(await errorCode(deniedHeader)).toBe("SLREST305");
  });

  it("echoes valid request IDs and replaces invalid IDs on every response", async () => {
    const configured = app();
    const inbound = await configured.handle(
      request("/health/live", { headers: { "X-Request-Id": "client:id-1" } }),
    );
    const invalid = await configured.handle(
      request("/missing", {
        headers: { "X-Request-Id": "invalid request id with secrets" },
      }),
    );

    expect(inbound.headers.get("X-Request-Id")).toBe("client:id-1");
    expect(invalid.headers.get("X-Request-Id")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
    expect(invalid.headers.get("X-Request-Id")).not.toContain("secrets");
  });

  it("logs one normalized completion record without request secrets", async () => {
    const events: Readonly<Record<string, unknown>>[] = [];
    const logger: RestLogger = {
      debug: () => {},
      info: (event) => events.push(event),
      warn: () => {},
      error: () => {},
    };
    const canary = "canary-secret-filter-body-key";
    const response = await app({ logger }).handle(
      request(`/users?name=eq.${canary}`, {
        headers: {
          Authorization: `Bearer ${canary}`,
          "X-Api-Key": canary,
          "X-Request-Id": "safe-id",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "request.completed",
      requestId: "safe-id",
      method: "GET",
      route: "/:resource",
      status: 200,
    });
    expect(typeof events[0]?.durationMs).toBe("number");
    expect(JSON.stringify(events[0])).not.toContain(canary);
    expect(JSON.stringify(events[0])).not.toContain("Authorization");
    expect(JSON.stringify(events[0])).not.toContain("name=eq");
  });

  it("records the stable error code without logging error internals", async () => {
    const events: Readonly<Record<string, unknown>>[] = [];
    const logger: RestLogger = {
      debug: () => {},
      info: (event) => events.push(event),
      warn: () => {},
      error: () => {},
    };
    const canary = "SELECT secret FROM /private/database.sqlite";
    const response = await app({
      logger,
      auth: { authorize: () => Promise.reject(new Error(canary)) },
    }).handle(request(`/users?name=eq.${encodeURIComponent(canary)}`));

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("SLREST304");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "/:resource",
      status: 500,
      errorCode: "SLREST304",
    });
    expect(JSON.stringify(events[0])).not.toContain(canary);
    expect(JSON.stringify(events[0])).not.toContain("SELECT");
    expect(JSON.stringify(events[0])).not.toContain("/private");
  });
});
