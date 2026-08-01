import { Elysia } from "elysia";
import { loadConfig } from "./config";
import {
  bunSQLiteConstants,
  type Database,
  openDatabase,
} from "./database/database";

export interface AppDependencies {
  database: Database;
}

export function createApp({ database }: AppDependencies) {
  return new Elysia().decorate("database", database).get("/health", () => ({
    status: "ok",
  }));
}

if (import.meta.main) {
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  const app = createApp({ database });

  let shutdownStarted = false;

  app.listen(config.port);

  console.log(
    `Setupless/rest is running at http://localhost:${app.server?.port}`,
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) return;

    shutdownStarted = true;
    console.log(`Received ${signal}; shutting down Setupless/rest`);

    try {
      await app.stop();
      database.fileControl(bunSQLiteConstants.SQLITE_FCNTL_PERSIST_WAL, 0);
      database.run("PRAGMA wal_checkpoint(TRUNCATE);");
      database.close();
    } catch (error) {
      console.error("Failed to shut down Setupless/rest cleanly", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
