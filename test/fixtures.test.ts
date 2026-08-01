import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

import {
  cleanupTestDatabase,
  createTestApp,
  createTestDatabase,
  seedTestDatabase,
} from "./fixtures";

describe("SQLite integration-test fixtures", () => {
  it("creates, seeds, and removes an isolated database", () => {
    const testDatabase = createTestDatabase();
    const { database, databasePath, directoryPath } = testDatabase;

    try {
      seedTestDatabase(database);

      expect(existsSync(databasePath)).toBe(true);
      expect(
        database
          .query<{ name: string; type: string }, []>(
            `SELECT name, type
             FROM sqlite_schema
             WHERE name IN ('users', 'active_users')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "active_users", type: "view" },
        { name: "users", type: "table" },
      ]);
      expect(
        database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM users")
          .get(),
      ).toEqual({ count: 3 });
      expect(createTestApp(database).server).toBeNull();
    } finally {
      cleanupTestDatabase(testDatabase);
    }

    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(directoryPath)).toBe(false);
  });
});
