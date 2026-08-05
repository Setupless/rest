export interface RestConfig {
  databasePath: string;
  port: number;
}

function loadConfig(env = process.env): RestConfig {
  const databasePath = env.DATABASE_PATH?.trim();
  const port = env.PORT ? Number(env.PORT) : 3000;

  if (!databasePath) {
    throw Error("DATABASE_PATH is required and must not be blank");
  }

  if (
    databasePath !== ":memory:" &&
    !databasePath.endsWith(".sqlite") &&
    !databasePath.endsWith(".db")
  ) {
    throw Error("DATABASE_PATH is required and must end in .sqlite or .db");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Error("PORT must be an integer between 1 and 65535 if present");
  }

  return {
    databasePath,
    port,
  };
}

export { loadConfig };
