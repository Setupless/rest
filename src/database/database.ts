import { constants as bunSQLiteConstants, Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs: number;
}

interface JournalModeRow {
  journal_mode: string;
}

interface ForeignKeysRow {
  foreign_keys: number;
}

interface BusyTimeoutRow {
  timeout: number;
}

function validateOptions(options: OpenDatabaseOptions): OpenDatabaseOptions {
  const path = options.path.trim();

  if (!path) {
    throw Error("Database path is required and must not be blank");
  }

  if (
    path !== ":memory:" &&
    !path.endsWith(".sqlite") &&
    !path.endsWith(".db")
  ) {
    throw Error("Database path must be :memory: or end in .sqlite or .db");
  }

  if (
    !Number.isInteger(options.busyTimeoutMs) ||
    options.busyTimeoutMs < 0 ||
    options.busyTimeoutMs > 600_000
  ) {
    throw Error("Database busy timeout must be an integer from 0 to 600000");
  }

  return { path, busyTimeoutMs: options.busyTimeoutMs };
}

function assertParentDirectory(path: string): void {
  if (path === ":memory:") return;

  try {
    if (!statSync(dirname(path)).isDirectory()) throw Error();
  } catch {
    throw Error("DATABASE_PATH parent directory must already exist");
  }
}

function initialiseDatabase(
  database: Database,
  { path, busyTimeoutMs }: OpenDatabaseOptions,
): void {
  if (path !== ":memory:") {
    const walResult = database
      .query<JournalModeRow, []>("PRAGMA journal_mode = WAL")
      .get();

    if (walResult?.journal_mode.toLowerCase() !== "wal") {
      throw Error("SQLite WAL mode could not be enabled");
    }
  }

  database.run("PRAGMA foreign_keys = ON");
  database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  const foreignKeys = database
    .query<ForeignKeysRow, []>("PRAGMA foreign_keys")
    .get();
  const busyTimeout = database
    .query<BusyTimeoutRow, []>("PRAGMA busy_timeout")
    .get();

  if (foreignKeys?.foreign_keys !== 1) {
    throw Error("SQLite foreign-key enforcement could not be enabled");
  }

  if (busyTimeout?.timeout !== busyTimeoutMs) {
    throw Error("SQLite busy timeout could not be configured");
  }
}

/** Open a SQLite database and verify all required connection PRAGMAs. */
export function openDatabase(rawOptions: OpenDatabaseOptions): Database {
  const options = validateOptions(rawOptions);
  assertParentDirectory(options.path);

  let database: Database;

  try {
    database = new Database(options.path, { strict: true });
  } catch {
    throw Error("DATABASE_PATH could not be opened as a SQLite database");
  }

  try {
    initialiseDatabase(database, options);
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the actionable initialization failure.
    }

    throw error;
  }
}

export { bunSQLiteConstants, type Database };
