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

  it("reads metadata from main when a temporary resource has the same name", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.exec(`
        CREATE TEMP TABLE users (
          temporary_key TEXT PRIMARY KEY,
          temporary_value BLOB
        )
      `);

      const schema = loadDatabaseSchema(testDatabase.database);
      const users = schema.getResource("users");

      expect(users?.columns.map((column) => column.name)).toEqual([
        "id",
        "name",
        "email",
        "age",
        "active",
        "created_at",
      ]);
      expect(users?.columns[0]?.nullable).toBe(false);
      expect(users?.primaryKey).toEqual(["id"]);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
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

  it("excludes virtual-table shadow tables and hidden columns", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.exec(
        "CREATE VIRTUAL TABLE documents USING fts5(title, body)",
      );

      const schema = loadDatabaseSchema(testDatabase.database);

      expect(schema.getResource("documents")).toEqual({
        name: "documents",
        type: "table",
        columns: ["title", "body"].map((name) => ({
          name,
          declaredType: "",
          nullable: true,
          defaultValue: null,
        })),
        primaryKey: [],
      });
      expect(schema.getResource("documents_data")).toBeUndefined();
      expect(schema.getResource("documents_idx")).toBeUndefined();
      expect(schema.getResource("documents_content")).toBeUndefined();
      expect(schema.getResource("documents_docsize")).toBeUndefined();
      expect(schema.getResource("documents_config")).toBeUndefined();
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("includes virtual and stored generated columns", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.exec(`
        CREATE TABLE measurements (
          value INTEGER NOT NULL,
          doubled INTEGER GENERATED ALWAYS AS (value * 2) VIRTUAL,
          label TEXT GENERATED ALWAYS AS ('value-' || value) STORED
        )
      `);

      const schema = loadDatabaseSchema(testDatabase.database);

      expect(schema.getResource("measurements")).toEqual({
        name: "measurements",
        type: "table",
        columns: [
          {
            name: "value",
            declaredType: "INTEGER",
            nullable: false,
            defaultValue: null,
          },
          {
            name: "doubled",
            declaredType: "INTEGER",
            nullable: true,
            defaultValue: null,
          },
          {
            name: "label",
            declaredType: "TEXT",
            nullable: true,
            defaultValue: null,
          },
        ],
        primaryKey: [],
      });
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("reports primary-key nullability according to the SQLite table kind", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.exec(`
        CREATE TABLE nullable_text_key (code TEXT PRIMARY KEY);
        CREATE TABLE nullable_composite_key (
          first INTEGER,
          second TEXT,
          PRIMARY KEY (first, second)
        );
        CREATE TABLE integer_rowid_alias (id INTEGER PRIMARY KEY);
        CREATE TABLE nullable_descending_integer_key (
          id INTEGER PRIMARY KEY DESC
        );
        CREATE TABLE without_rowid_key (code TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE strict_key (code TEXT PRIMARY KEY) STRICT;
      `);

      const schema = loadDatabaseSchema(testDatabase.database);
      const nullable = (resource: string, column = 0) =>
        schema.getResource(resource)?.columns[column]?.nullable;

      expect(nullable("nullable_text_key")).toBe(true);
      expect(nullable("nullable_composite_key", 0)).toBe(true);
      expect(nullable("nullable_composite_key", 1)).toBe(true);
      expect(nullable("integer_rowid_alias")).toBe(false);
      expect(nullable("nullable_descending_integer_key")).toBe(true);
      expect(nullable("without_rowid_key")).toBe(false);
      expect(nullable("strict_key")).toBe(false);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });
});
