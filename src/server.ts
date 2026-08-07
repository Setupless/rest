import { createRestApp } from "./app";
import { createApiKeyAuth } from "./auth/api-key";
import type { RestAuthPlugin } from "./auth/types";
import { loadConfig, type RestConfig } from "./config";
import {
  bunSQLiteConstants,
  type Database,
  openDatabase,
} from "./database/database";
import { loadDatabaseSchema } from "./database/schema";
import { createJsonLogger, type RestLogger, safeLog } from "./logging/logger";

/** A listening server whose resources can be released exactly once. */
export interface RunningRestServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Overrides for starting a server programmatically. */
export interface ServeRestOptions {
  config?: RestConfig;
  auth?: RestAuthPlugin;
  logger?: RestLogger;
}

const START_FAILURE_MESSAGE = "Setupless/rest failed to start and clean up";

type ShutdownStep = "http" | "wal-persistence" | "wal-checkpoint" | "database";

class RestServerShutdownError extends AggregateError {
  readonly failedSteps: readonly ShutdownStep[];

  constructor(failures: readonly { step: ShutdownStep; error: unknown }[]) {
    super(
      failures.map((failure) => failure.error),
      "Failed to shut down Setupless/rest cleanly",
    );
    this.name = "RestServerShutdownError";
    this.failedSteps = Object.freeze(failures.map((failure) => failure.step));
  }
}

async function cleanupAfterStartFailure(
  error: unknown,
  cleanup: () => void | Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], START_FAILURE_MESSAGE);
  }

  throw error;
}

async function closeServerResources(
  app: ReturnType<typeof createRestApp>,
  database: Database,
): Promise<void> {
  const failures: { step: ShutdownStep; error: unknown }[] = [];

  if (app.server !== null) {
    try {
      await app.stop();
    } catch (error) {
      failures.push({ step: "http", error });
    }
  }

  try {
    database.fileControl(bunSQLiteConstants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch (error) {
    failures.push({ step: "wal-persistence", error });
  }

  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    failures.push({ step: "wal-checkpoint", error });
  }

  try {
    database.close();
  } catch (error) {
    failures.push({ step: "database", error });
  }

  if (failures.length > 0) {
    throw new RestServerShutdownError(failures);
  }
}

/** Opens configured resources, starts listening, and installs signal handlers. */
export async function serveRest(
  options: ServeRestOptions = {},
): Promise<RunningRestServer> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createJsonLogger(config.logLevel);
  const auth =
    options.auth ??
    (config.apiKey === undefined ? undefined : createApiKeyAuth(config.apiKey));

  if (!auth) {
    throw Error(
      "Programmatic startup requires SETUPLESS_REST_API_KEY or an auth plugin",
    );
  }

  const database = openDatabase({
    path: config.databasePath,
    busyTimeoutMs: config.busyTimeoutMs,
  });
  let app: ReturnType<typeof createRestApp>;

  try {
    const schema = loadDatabaseSchema(database);
    app = createRestApp({
      database,
      schema,
      auth,
      maxFilterDepth: config.maxEmbedDepth,
      maxRows: config.maxRows,
      maxEmbedDepth: config.maxEmbedDepth,
      maxBodyBytes: config.maxBodyBytes,
      corsOrigins: config.corsOrigins,
      logger,
    });
  } catch (error) {
    return cleanupAfterStartFailure(error, () => database.close());
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

    safeLog(logger, "info", { event: "server.signal", signal });
    void stop().catch((error: unknown) => {
      safeLog(logger, "error", {
        event: "server.shutdown_failed",
        reason:
          error instanceof RestServerShutdownError
            ? error.message
            : "Setupless/rest shutdown failed",
        failedSteps:
          error instanceof RestServerShutdownError
            ? error.failedSteps
            : Object.freeze(["unknown"]),
      });
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
    app.listen({ hostname: config.host, port: config.port });

    const port = app.server?.port;

    if (port === undefined) {
      throw Error("Setupless/rest did not expose a listening port");
    }

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    safeLog(logger, "info", {
      event: "server.started",
      host: config.host,
      port,
    });

    return Object.freeze({ port, stop });
  } catch (error) {
    return cleanupAfterStartFailure(error, stop);
  }
}
