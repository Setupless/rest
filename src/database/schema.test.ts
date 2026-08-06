import { describe, expect, it } from "bun:test";

import {
  cleanupTestDatabase,
  createTestDatabase,
  useTestFixture,
} from "../../test/fixtures";
import {
  type DatabaseColumn,
  getSQLiteAffinity,
  loadDatabaseSchema,
} from "./schema";

interface ExpectedColumnOptions {
  cid: number;
  name: string;
  declaredType: string;
  nullable?: boolean;
  defaultValue?: string | null;
  primaryKeyPosition?: number | null;
  generated?: false | "virtual" | "stored";
  writable?: boolean;
}

function expectedColumn({
  cid,
  name,
  declaredType,
  nullable = true,
  defaultValue = null,
  primaryKeyPosition = null,
  generated = false,
  writable = true,
}: ExpectedColumnOptions): DatabaseColumn {
  return {
    cid,
    name,
    declaredType,
    affinity: getSQLiteAffinity(declaredType),
    nullable,
    defaultValue,
    primaryKeyPosition,
    generated,
    writable,
  };
}

describe("getSQLiteAffinity", () => {
  it.each([
    ["INTEGER", "integer"],
    ["unsigned big int", "integer"],
    ["CHARINT", "integer"],
    ["FLOATING POINT", "integer"],
    ["VARCHAR(255)", "text"],
    ["CLOB", "text"],
    ["TEXT", "text"],
    ["", "blob"],
    ["BLOB", "blob"],
    ["DOUBLE PRECISION", "real"],
    ["FLOAT", "real"],
    ["REAL", "real"],
    ["BOOLEAN", "numeric"],
    ["DECIMAL(10,5)", "numeric"],
    ["STRING", "numeric"],
  ] as const)("maps %s to %s affinity", (declaredType, affinity) => {
    expect(getSQLiteAffinity(declaredType)).toBe(affinity);
  });
});

describe("loadDatabaseSchema", () => {
  const fixture = useTestFixture();

  it("discovers complete table and column metadata", () => {
    expect(fixture.schema.getResource("users")).toEqual({
      name: "users",
      kind: "table",
      writable: true,
      columns: [
        expectedColumn({
          cid: 0,
          name: "id",
          declaredType: "INTEGER",
          nullable: false,
          primaryKeyPosition: 1,
        }),
        expectedColumn({
          cid: 1,
          name: "name",
          declaredType: "TEXT",
          nullable: false,
        }),
        expectedColumn({ cid: 2, name: "email", declaredType: "TEXT" }),
        expectedColumn({ cid: 3, name: "age", declaredType: "INTEGER" }),
        expectedColumn({
          cid: 4,
          name: "active",
          declaredType: "INTEGER",
          nullable: false,
          defaultValue: "1",
        }),
        expectedColumn({
          cid: 5,
          name: "created_at",
          declaredType: "TEXT",
          nullable: false,
          defaultValue: "CURRENT_TIMESTAMP",
        }),
      ],
      primaryKey: ["id"],
      uniqueConstraints: [
        { columns: ["id"], primary: true },
        { columns: ["email"], primary: false },
      ],
      foreignKeys: [],
    });
  });

  it("marks views and all of their columns read-only", () => {
    expect(fixture.schema.getResource("active_users")).toEqual({
      name: "active_users",
      kind: "view",
      writable: false,
      columns: ["id", "name", "email", "age", "active", "created_at"].map(
        (name, cid) =>
          expectedColumn({
            cid,
            name,
            declaredType:
              name === "id" || name === "age" || name === "active"
                ? "INTEGER"
                : "TEXT",
            writable: false,
          }),
      ),
      primaryKey: [],
      uniqueConstraints: [],
      foreignKeys: [],
    });
  });

  it("lists resources in deterministic name order", () => {
    expect(
      fixture.schema.listResources().map((resource) => resource.name),
    ).toEqual(["active_users", "users"]);
    expect(fixture.schema.listResources()).toBe(fixture.schema.listResources());
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
    const resources = fixture.schema.listResources();

    fixture.database.run("CREATE TABLE added_after_startup (id INTEGER)");

    expect(fixture.schema.getResource("added_after_startup")).toBeUndefined();
    expect(fixture.schema.getResource("users")).toBe(users);
    expect(fixture.schema.listResources()).toBe(resources);
  });

  it("reads all metadata from main when temporary resources have the same names", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TEMP TABLE users (
          temporary_key TEXT PRIMARY KEY,
          temporary_value BLOB UNIQUE
        );
        CREATE TEMP VIEW active_users AS SELECT * FROM users;
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
      expect(users?.primaryKey).toEqual(["id"]);
      expect(users?.uniqueConstraints).toEqual([
        { columns: ["id"], primary: true },
        { columns: ["email"], primary: false },
      ]);
      expect(schema.getResource("active_users")?.kind).toBe("view");
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("preserves composite primary-key positions and declared order", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE memberships (
          account_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          role VARCHAR(20) DEFAULT 'viewer',
          PRIMARY KEY (user_id, account_id)
        )
      `);

      const resource = loadDatabaseSchema(testDatabase.database).getResource(
        "memberships",
      );

      expect(resource?.primaryKey).toEqual(["user_id", "account_id"]);
      expect(
        resource?.columns.map((column) => ({
          name: column.name,
          position: column.primaryKeyPosition,
        })),
      ).toEqual([
        { name: "account_id", position: 2 },
        { name: "user_id", position: 1 },
        { name: "role", position: null },
      ]);
      expect(resource?.uniqueConstraints).toEqual([
        { columns: ["user_id", "account_id"], primary: true },
      ]);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("includes only unconditional column-based unique constraints", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE unique_examples (
          id INTEGER PRIMARY KEY,
          tenant TEXT,
          slug TEXT,
          email TEXT UNIQUE,
          alias TEXT,
          UNIQUE (slug, tenant)
        );
        CREATE UNIQUE INDEX unique_alias
          ON unique_examples (alias);
        CREATE UNIQUE INDEX partial_email
          ON unique_examples (email)
          WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX expression_alias
          ON unique_examples (lower(alias));
      `);

      expect(
        loadDatabaseSchema(testDatabase.database).getResource("unique_examples")
          ?.uniqueConstraints,
      ).toEqual([
        { columns: ["id"], primary: true },
        { columns: ["alias"], primary: false },
        { columns: ["email"], primary: false },
        { columns: ["slug", "tenant"], primary: false },
      ]);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("preserves named, unnamed, and composite foreign-key column order", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE "Organizations" (
          "Tenant" TEXT NOT NULL,
          "Slug" TEXT NOT NULL,
          PRIMARY KEY ("Slug", "Tenant")
        );
        CREATE TABLE memberships (
          organization_slug TEXT,
          organization_tenant TEXT,
          user_id INTEGER,
          CONSTRAINT membership_organization
            FOREIGN KEY (organization_slug, organization_tenant)
            REFERENCES organizations (slug, tenant),
          FOREIGN KEY (user_id) REFERENCES users (id)
        );
        CREATE TABLE invitations (
          organization_slug TEXT,
          organization_tenant TEXT,
          FOREIGN KEY (organization_slug, organization_tenant)
            REFERENCES ORGANIZATIONS
        );
      `);

      const schema = loadDatabaseSchema(testDatabase.database);
      const membershipForeignKeys =
        schema.getResource("memberships")?.foreignKeys ?? [];
      const organizationForeignKey = membershipForeignKeys.find(
        (foreignKey) => foreignKey.referencedResource === "Organizations",
      );
      const userForeignKey = membershipForeignKeys.find(
        (foreignKey) => foreignKey.referencedResource === "users",
      );

      expect(membershipForeignKeys.map((foreignKey) => foreignKey.id)).toEqual(
        [...membershipForeignKeys]
          .map((foreignKey) => foreignKey.id)
          .sort((left, right) => left - right),
      );
      expect(organizationForeignKey).toMatchObject({
        fromColumns: ["organization_slug", "organization_tenant"],
        referencedResource: "Organizations",
        referencedColumns: ["Slug", "Tenant"],
      });
      expect(userForeignKey).toMatchObject({
        fromColumns: ["user_id"],
        referencedResource: "users",
        referencedColumns: ["id"],
      });
      expect(Object.isFrozen(membershipForeignKeys)).toBe(true);
      expect(Object.isFrozen(organizationForeignKey)).toBe(true);
      expect(Object.isFrozen(organizationForeignKey?.fromColumns)).toBe(true);
      expect(Object.isFrozen(organizationForeignKey?.referencedColumns)).toBe(
        true,
      );
      expect(schema.getResource("invitations")?.foreignKeys).toEqual([
        {
          id: 0,
          fromColumns: ["organization_slug", "organization_tenant"],
          referencedResource: "Organizations",
          referencedColumns: ["Slug", "Tenant"],
        },
      ]);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("preserves distinct non-ASCII resource names when resolving foreign keys", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE "Ä" (id INTEGER PRIMARY KEY);
        CREATE TABLE "ä" (code TEXT PRIMARY KEY);
        CREATE TABLE non_ascii_references (
          upper_id INTEGER REFERENCES "Ä" (id),
          lower_code TEXT REFERENCES "ä" (code)
        );
      `);

      const foreignKeys =
        loadDatabaseSchema(testDatabase.database).getResource(
          "non_ascii_references",
        )?.foreignKeys ?? [];

      expect(
        foreignKeys.map((foreignKey) => foreignKey.referencedResource).sort(),
      ).toEqual(["Ä", "ä"]);
      expect(
        foreignKeys.find((foreignKey) => foreignKey.referencedResource === "Ä"),
      ).toMatchObject({
        fromColumns: ["upper_id"],
        referencedColumns: ["id"],
      });
      expect(
        foreignKeys.find((foreignKey) => foreignKey.referencedResource === "ä"),
      ).toMatchObject({
        fromColumns: ["lower_code"],
        referencedColumns: ["code"],
      });
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("excludes virtual-table shadow tables and hidden columns", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(
        "CREATE VIRTUAL TABLE documents USING fts5(title, body)",
      );

      const schema = loadDatabaseSchema(testDatabase.database);

      expect(schema.getResource("documents")).toEqual({
        name: "documents",
        kind: "virtual-table",
        writable: false,
        columns: ["title", "body"].map((name, cid) =>
          expectedColumn({
            cid,
            name,
            declaredType: "",
            writable: false,
          }),
        ),
        primaryKey: [],
        uniqueConstraints: [],
        foreignKeys: [],
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

  it("includes generated columns but never marks them writable", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE measurements (
          value INTEGER NOT NULL,
          doubled INTEGER GENERATED ALWAYS AS (value * 2) VIRTUAL,
          label TEXT GENERATED ALWAYS AS ('value-' || value) STORED
        )
      `);

      expect(
        loadDatabaseSchema(testDatabase.database).getResource("measurements"),
      ).toEqual({
        name: "measurements",
        kind: "table",
        writable: true,
        columns: [
          expectedColumn({
            cid: 0,
            name: "value",
            declaredType: "INTEGER",
            nullable: false,
          }),
          expectedColumn({
            cid: 1,
            name: "doubled",
            declaredType: "INTEGER",
            generated: "virtual",
            writable: false,
          }),
          expectedColumn({
            cid: 2,
            name: "label",
            declaredType: "TEXT",
            generated: "stored",
            writable: false,
          }),
        ],
        primaryKey: [],
        uniqueConstraints: [],
        foreignKeys: [],
      });
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("marks ordinary, STRICT, and WITHOUT ROWID tables writable", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
        CREATE TABLE ordinary_table (value TEXT);
        CREATE TABLE strict_table (code TEXT PRIMARY KEY) STRICT;
        CREATE TABLE without_rowid_table (
          code TEXT PRIMARY KEY
        ) WITHOUT ROWID;
      `);

      const schema = loadDatabaseSchema(testDatabase.database);

      for (const name of [
        "ordinary_table",
        "strict_table",
        "without_rowid_table",
      ]) {
        const resource = schema.getResource(name);
        expect(resource?.kind).toBe("table");
        expect(resource?.writable).toBe(true);
        expect(resource?.columns.every((column) => column.writable)).toBe(true);
      }
      expect(schema.getResource("strict_table")?.columns[0]?.nullable).toBe(
        false,
      );
      expect(
        schema.getResource("without_rowid_table")?.columns[0]?.nullable,
      ).toBe(false);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });

  it("reports primary-key nullability according to the SQLite table kind", () => {
    const testDatabase = createTestDatabase();

    try {
      testDatabase.database.run(`
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

  it("deeply freezes every public snapshot collection and object", () => {
    const schema = fixture.schema;
    const resources = schema.listResources();
    const users = schema.getResource("users");
    const id = users?.columns[0];
    const primary = users?.uniqueConstraints[0];

    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(users)).toBe(true);
    expect(Object.isFrozen(users?.columns)).toBe(true);
    expect(Object.isFrozen(id)).toBe(true);
    expect(Object.isFrozen(users?.primaryKey)).toBe(true);
    expect(Object.isFrozen(users?.uniqueConstraints)).toBe(true);
    expect(Object.isFrozen(primary)).toBe(true);
    expect(Object.isFrozen(primary?.columns)).toBe(true);
    expect(Object.isFrozen(users?.foreignKeys)).toBe(true);

    expect(() =>
      (resources as unknown as Array<unknown>).push(users),
    ).toThrow();
    expect(() => {
      (users as unknown as { name: string }).name = "changed";
    }).toThrow();
    expect(() => {
      (id as unknown as { name: string }).name = "changed";
    }).toThrow();
  });
});
