import { createRestApp } from "./app";
import { loadConfig, type RestConfig } from "./config";
import {
  bunSQLiteConstants,
  type Database,
  openDatabase,
} from "./database/database";
import { loadDatabaseSchema } from "./database/schema";

/** A listening server whose resources can be released exactly once. */
export interface RunningRestServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Overrides for starting a server programmatically. */
export interface ServeRestOptions {
  config?: RestConfig;
}

async function closeServerResources(
  app: ReturnType<typeof createRestApp>,
  database: Database,
): Promise<void> {
  const errors: unknown[] = [];

  if (app.server !== null) {
    try {
      await app.stop();
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    database.fileControl(bunSQLiteConstants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch (error) {
    errors.push(error);
  }

  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    errors.push(error);
  }

  try {
    database.close();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Failed to shut down Setupless/rest cleanly",
    );
  }
}

/** Opens configured resources, starts listening, and installs signal handlers. */
export async function serveRest(
  options: ServeRestOptions = {},
): Promise<RunningRestServer> {
  const config = options.config ?? loadConfig();
  const database = openDatabase(config.databasePath);
  let app: ReturnType<typeof createRestApp>;

  try {
    const schema = loadDatabaseSchema(database);
    app = createRestApp({ database, schema });
  } catch (error) {
    try {
      database.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Setupless/rest failed to start and clean up",
      );
    }

    throw error;
  }

  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = closeServerResources(app, database).finally(() => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      });
    }

    return stopPromise;
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    if (stopPromise) return;

    console.log(`Received ${signal}; shutting down Setupless/rest`);
    void stop().catch((error) => {
      console.error("Failed to shut down Setupless/rest cleanly", error);
      process.exitCode = 1;
    });
  };

  function onSigint() {
    handleSignal("SIGINT");
  }

  function onSigterm() {
    handleSignal("SIGTERM");
  }

  try {
    app.listen(config.port);

    const port = app.server?.port;

    if (port === undefined) {
      throw Error("Setupless/rest did not expose a listening port");
    }

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    console.log(`Setupless/rest is running at http://localhost:${port}`);

    return Object.freeze({ port, stop });
  } catch (error) {
    try {
      await stop();
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "Setupless/rest failed to start and clean up",
      );
    }

    throw error;
  }
}
