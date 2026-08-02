import { describe, expect, it } from "bun:test";

import {
  cleanupTestDatabase,
  createTestDatabase,
  useTestFixture,
} from "../../test/fixtures";
import { loadDatabaseSchema } from "./schema";

describe("loadDatabaseSchema", () => {
  const fixture = useTestFixture();

  it("discovers table columns, types, nullability, defaults, and primary keys", () => {
    expect(fixture.schema.getResource("users")).toEqual({
      name: "users",
      type: "table",
      columns: [
        {
          name: "id",
          declaredType: "INTEGER",
          nullable: false,
          defaultValue: null,
        },
        {
          name: "name",
          declaredType: "TEXT",
          nullable: false,
          defaultValue: null,
        },
        {
          name: "email",
          declaredType: "TEXT",
          nullable: true,
          defaultValue: null,
        },
        {
          name: "age",
          declaredType: "INTEGER",
          nullable: true,
          defaultValue: null,
        },
        {
          name: "active",
          declaredType: "INTEGER",
          nullable: false,
          defaultValue: "1",
        },
        {
          name: "created_at",
          declaredType: "TEXT",
          nullable: false,
          defaultValue: "CURRENT_TIMESTAMP",
        },
      ],
      primaryKey: ["id"],
    });
  });

  it("discovers views and their columns", () => {
    expect(fixture.schema.getResource("active_users")).toEqual({
      name: "active_users",
      type: "view",
      columns: ["id", "name", "email", "age", "active", "created_at"].map(
        (name) => ({
          name,
          declaredType:
            name === "id" || name === "age" || name === "active"
              ? "INTEGER"
              : "TEXT",
          nullable: true,
          defaultValue: null,
        }),
      ),
      primaryKey: [],
    });
  });

  it("returns undefined for internal, unknown, and untrusted resource names", () => {
    expect(fixture.schema.getResource("sqlite_sequence")).toBeUndefined();
    expect(
      fixture.schema.getResource("sqlite_autoindex_users_1"),
    ).toBeUndefined();
    expect(fixture.schema.getResource("does_not_exist")).toBeUndefined();
    expect(
      fixture.schema.getResource('users"; DROP TABLE users; --'),
    ).toBeUndefined();
  });

  it("keeps the startup snapshot instead of querying for each lookup", () => {
    const users = fixture.schema.getResource("users");

    fixture.database.exec("CREATE TABLE added_after_startup (id INTEGER)");

    expect(fixture.schema.getResource("added_after_startup")).toBeUndefined();
    expect(fixture.schema.getResource("users")).toBe(users);
  });

  it("preserves the declared order of a composite primary key", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.exec(`
        CREATE TABLE memberships (
          account_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          role VARCHAR(20) DEFAULT 'viewer',
          PRIMARY KEY (user_id, account_id)
        )
      `);

      const schema = loadDatabaseSchema(testDatabase.database);

      expect(schema.getResource("memberships")).toEqual({
        name: "memberships",
        type: "table",
        columns: [
          {
            name: "account_id",
            declaredType: "TEXT",
            nullable: false,
            defaultValue: null,
          },
          {
            name: "user_id",
            declaredType: "INTEGER",
            nullable: false,
            defaultValue: null,
          },
          {
            name: "role",
            declaredType: "VARCHAR(20)",
            nullable: true,
            defaultValue: "'viewer'",
          },
        ],
        primaryKey: ["user_id", "account_id"],
      });
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });
});
