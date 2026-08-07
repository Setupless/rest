import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { cleanupTestDatabase, createTestDatabase } from "../../test/fixtures";
import { createRestApp } from "../app";
import { openDatabase } from "../database/database";
import { loadDatabaseSchema } from "../database/schema";

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("health routes", () => {
  it("keeps liveness available when readiness loses its database", async () => {
    const database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });
    const app = createRestApp({
      database,
      schema: loadDatabaseSchema(database),
    });
    database.close();

    const readiness = await app.handle(
      new Request("http://setupless.test/health"),
    );
    const liveness = await app.handle(
      new Request("http://setupless.test/health/live"),
    );

    expect(readiness.status).toBe(503);
    expect(await errorCode(readiness)).toBe("SLREST503");
    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toEqual({ status: "ok" });
  });

  it("maps a bounded readiness lock to the retryable busy response", async () => {
    const fixture = createTestDatabase();
    const { database, databasePath } = fixture;
    let blocker: Database | undefined;

    try {
      database.run("PRAGMA wal_checkpoint(TRUNCATE)");
      database.run("PRAGMA journal_mode = DELETE");
      database.run("PRAGMA busy_timeout = 0");
      const app = createRestApp({
        database,
        schema: loadDatabaseSchema(database),
      });
      blocker = new Database(databasePath, { strict: true });
      blocker.run("PRAGMA busy_timeout = 0");
      blocker.run("BEGIN EXCLUSIVE");

      const response = await app.handle(
        new Request("http://setupless.test/health"),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await errorCode(response)).toBe("SLREST502");
    } finally {
      if (blocker !== undefined) {
        try {
          blocker.run("ROLLBACK");
        } catch {
          // The assertion path may fail before the lock is acquired.
        }
        blocker.close();
      }
      cleanupTestDatabase(fixture);
    }
  });
});
