import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestApp } from "../src/app";
import { type Database, openDatabase } from "../src/database/database";
import {
  type DatabaseSchema,
  loadDatabaseSchema,
} from "../src/database/schema";

const TEST_DATABASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIEW active_users AS
SELECT *
FROM users
WHERE active = 1;
`;

export interface TestUser {
  name: string;
  email: string | null;
  age: number | null;
  active: 0 | 1;
  createdAt: string;
}

export const TEST_USERS = [
  {
    name: "Alice Johnson",
    email: "alice@example.com",
    age: 30,
    active: 1,
    createdAt: "2026-01-01 09:00:00",
  },
  {
    name: "Bob Smith",
    email: "bob@example.com",
    age: 42,
    active: 0,
    createdAt: "2026-01-02 10:30:00",
  },
  {
    name: "Charlie Brown",
    email: "charlie@example.com",
    age: null,
    active: 1,
    createdAt: "2026-01-03 15:45:00",
  },
] as const satisfies readonly TestUser[];

export interface TestDatabase {
  database: Database;
  databasePath: string;
  directoryPath: string;
}

export interface TestFixture extends TestDatabase {
  app: ReturnType<typeof createRestApp>;
  schema: DatabaseSchema;
  cleanup: () => void;
}

export function createTestDatabase(): TestDatabase {
  const directoryPath = mkdtempSync(join(tmpdir(), "setupless-rest-"));
  const databasePath = join(directoryPath, "database.sqlite");
  let database: Database | undefined;

  try {
    database = openDatabase(databasePath);
    database.exec(TEST_DATABASE_SCHEMA);

    return { database, databasePath, directoryPath };
  } catch (error) {
    database?.close();
    rmSync(directoryPath, { recursive: true, force: true });
    throw error;
  }
}

export function seedTestDatabase(
  database: Database,
  users: readonly TestUser[] = TEST_USERS,
) {
  const insert = database.prepare<
    void,
    [string, string | null, number | null, 0 | 1, string]
  >(`
    INSERT INTO users (name, email, age, active, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertUsers = database.transaction((records: readonly TestUser[]) => {
    for (const user of records) {
      insert.run(user.name, user.email, user.age, user.active, user.createdAt);
    }
  });

  try {
    insertUsers(users);
  } finally {
    insert.finalize();
  }
}

export function createTestApp(database: Database, schema: DatabaseSchema) {
  return createRestApp({ database, schema });
}

export function cleanupTestDatabase({ database, directoryPath }: TestDatabase) {
  try {
    database.close();
  } finally {
    rmSync(directoryPath, { recursive: true, force: true });
  }
}

export function createTestFixture(): TestFixture {
  const testDatabase = createTestDatabase();
  const schema = loadDatabaseSchema(testDatabase.database);
  let cleanedUp = false;

  try {
    seedTestDatabase(testDatabase.database);
    const app = createTestApp(testDatabase.database, schema);

    return {
      ...testDatabase,
      app,
      schema,
      cleanup: () => {
        if (cleanedUp) return;

        cleanedUp = true;
        cleanupTestDatabase(testDatabase);
      },
    };
  } catch (error) {
    cleanupTestDatabase(testDatabase);
    throw error;
  }
}

export function useTestFixture(): Omit<TestFixture, "cleanup"> {
  let fixture: TestFixture | undefined;

  const getFixture = () => {
    if (!fixture) {
      throw Error("Test fixture is only available inside its test suite");
    }

    return fixture;
  };

  beforeAll(() => {
    fixture = createTestFixture();
  });

  afterAll(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  return {
    get app() {
      return getFixture().app;
    },
    get database() {
      return getFixture().database;
    },
    get schema() {
      return getFixture().schema;
    },
    get databasePath() {
      return getFixture().databasePath;
    },
    get directoryPath() {
      return getFixture().directoryPath;
    },
  };
}
