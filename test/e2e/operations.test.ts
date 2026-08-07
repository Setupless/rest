import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2EDatabase } from "./fixture";
import { expectErrorCode, startE2EServer, useE2EServer } from "./server";

describe("black-box operational HTTP behavior", () => {
  const server = useE2EServer({
    corsOrigins: ["https://app.example"],
    logLevel: "info",
  });

  it("[health-readiness] and [health-liveness] expose distinct probes", async () => {
    const readiness = await server.request("/health");
    const liveness = await server.request("/health/live");

    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({
      status: "ok",
      database: "ready",
    });
    expect(await liveness.json()).toEqual({ status: "ok" });
  });

  it("[request-id] echoes valid IDs and replaces invalid IDs", async () => {
    const valid = await server.request("/health/live", {
      headers: { "X-Request-Id": "operator:request-1" },
    });
    const invalid = await server.request("/health/live", {
      headers: { "X-Request-Id": "invalid request id" },
    });

    expect(valid.headers.get("X-Request-Id")).toBe("operator:request-1");
    expect(invalid.headers.get("X-Request-Id")).not.toBe("invalid request id");
    expect(invalid.headers.get("X-Request-Id")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
  });

  it("[cors] permits exact configured origins and route-aware preflights", async () => {
    const allowed = await server.request("/tasks?limit=0", {
      headers: { Origin: "https://app.example" },
    });
    const preflight = await fetch(`${server.origin}/tasks`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization, content-type, prefer",
      },
    });
    const denied = await fetch(`${server.origin}/tasks`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
    expect(allowed.headers.get("Vary")).toContain("Origin");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT",
    );
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, Prefer",
    );
    await expectErrorCode(denied, "SLREST305");
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("[structured-logging] logs normalized metadata without query values", async () => {
    await server.request("/tasks?title=eq.log-secret-canary", {
      headers: { "X-Request-Id": "logging-contract" },
    });
    await Bun.sleep(10);
    const lines = server
      .diagnostics()
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completion = lines.find(
      (line) =>
        line.event === "request.completed" &&
        line.requestId === "logging-contract",
    );

    expect(completion).toMatchObject({
      method: "GET",
      route: "/:resource",
      status: 200,
    });
    expect(completion?.durationMs).toBeNumber();
    expect(JSON.stringify(lines)).not.toContain("log-secret-canary");
    expect(JSON.stringify(lines)).not.toContain(server.databasePath);
  });
});

describe("black-box database and process lifecycle", () => {
  it("[database-creation] creates a missing database inside an existing parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-rest-create-"));
    const databasePath = join(directory, "created.sqlite");

    try {
      const server = await startE2EServer({ databasePath });
      try {
        expect(existsSync(databasePath)).toBe(true);
        expect((await server.request("/health")).status).toBe(200);
        const root = (await (await server.request("/")).json()) as {
          paths: Record<string, unknown>;
        };
        expect(Object.keys(root.paths)).toEqual([
          "/",
          "/health",
          "/health/live",
        ]);
      } finally {
        await server.stop();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("[database-persistence] checkpoints writes and refreshes schema only after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-rest-restart-"));
    const databasePath = join(directory, "persistent.sqlite");
    createE2EDatabase(databasePath);

    try {
      const first = await startE2EServer({ databasePath });
      const inserted = await first.request("/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "missing=default",
        },
        body: JSON.stringify({
          id: 70,
          project_id: 10,
          title: "Persist after shutdown",
        }),
      });
      expect(inserted.status).toBe(201);

      const writer = new Database(databasePath, { strict: true });
      try {
        writer.run("CREATE TABLE late_resource (id INTEGER PRIMARY KEY)");
      } finally {
        writer.close();
      }
      const stale = await first.request("/late_resource");
      await expectErrorCode(stale, "SLREST200");
      await first.stop("SIGTERM");

      const persisted = new Database(databasePath, {
        readonly: true,
        strict: true,
      });
      try {
        expect(
          persisted
            .query<{ total: number }, []>(
              "SELECT COUNT(*) AS total FROM tasks WHERE id = 70",
            )
            .get()?.total,
        ).toBe(1);
      } finally {
        persisted.close();
      }

      const restarted = await startE2EServer({ databasePath });
      try {
        const refreshed = await restarted.request("/late_resource");
        expect(refreshed.status).toBe(200);
        expect(await refreshed.json()).toEqual([]);
      } finally {
        await restarted.stop("SIGINT");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("[database-contention] maps write locks to a retryable 503", async () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-rest-lock-"));
    const databasePath = join(directory, "locked.sqlite");
    createE2EDatabase(databasePath);

    try {
      const server = await startE2EServer({ databasePath, busyTimeoutMs: 0 });
      const locker = new Database(databasePath, { strict: true });
      try {
        locker.run("BEGIN IMMEDIATE");
        const response = await server.request("/tasks?id=eq.1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: 1 }),
        });

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
        await expectErrorCode(response, "SLREST502");
      } finally {
        locker.run("ROLLBACK");
        locker.close();
        await server.stop();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`[graceful-${signal.toLowerCase()}] stops cleanly without orphaning the listener`, async () => {
      const server = await startE2EServer();
      const origin = server.origin;

      await server.stop(signal);
      expect(await fetch(origin).catch(() => undefined)).toBeUndefined();
      await expect(server.stop(signal)).resolves.toBeUndefined();
    });
  }
});
