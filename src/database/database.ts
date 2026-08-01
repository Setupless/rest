import { constants as bunSQLiteConstants, Database } from "bun:sqlite";

function openDatabase(path: string): Database {
  if (!path) {
    throw Error("path is required and must not be blank");
  }

  const database = new Database(path, { strict: true });

  if (path !== ":memory:") {
    const walResult = database
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
      .get();

    if (walResult?.journal_mode !== "wal") {
      database.close();
      throw Error("Failed to correctly initialise the database");
    }
  }

  database.query("PRAGMA foreign_keys = ON");

  return database;
}

export { bunSQLiteConstants, type Database, openDatabase };
