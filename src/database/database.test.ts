import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "./database";

describe("openDatabase", () => {
  it("creates a missing database and verifies required PRAGMAs", () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-database-"));
    const path = join(directory, "created.sqlite");
    const database = openDatabase({ path, busyTimeoutMs: 4321 });

    try {
      expect(existsSync(path)).toBe(true);
      expect(database.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(database.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 4321,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("configures foreign keys and busy timeout for in-memory databases", () => {
    const database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });

    try {
      expect(database.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "memory",
      });
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(database.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 0,
      });
    } finally {
      database.close();
    }
  });

  it("does not create a missing parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-database-"));
    const missingParent = join(directory, "missing");
    const path = join(missingParent, "database.sqlite");

    try {
      expect(() => openDatabase({ path, busyTimeoutMs: 5000 })).toThrow(
        "DATABASE_PATH parent directory must already exist",
      );
      expect(existsSync(missingParent)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["", "database.txt"])("rejects invalid path %p", (path) => {
    expect(() => openDatabase({ path, busyTimeoutMs: 5000 })).toThrow(
      "Database path",
    );
  });

  it.each([-1, 1.5, 600_001])(
    "rejects invalid busy timeout %p",
    (busyTimeoutMs) => {
      expect(() => openDatabase({ path: ":memory:", busyTimeoutMs })).toThrow(
        "Database busy timeout must be an integer from 0 to 600000",
      );
    },
  );

  it("does not disclose an invalid database path", () => {
    const path = "/private/secret/location/database.sqlite";

    try {
      openDatabase({ path, busyTimeoutMs: 5000 });
    } catch (error) {
      expect(String(error)).not.toContain(path);
    }
  });
});
