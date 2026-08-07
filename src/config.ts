import { isIP } from "node:net";

export type RestLogLevel = "debug" | "info" | "warn" | "error";

export interface RestConfig {
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  readonly apiKey?: string;
  readonly maxRows: number;
  readonly maxEmbedDepth: number;
  readonly maxBodyBytes: number;
  readonly busyTimeoutMs: number;
  readonly corsOrigins: readonly string[];
  readonly logLevel: RestLogLevel;
}

type Environment = Record<string, string | undefined>;

const LOG_LEVELS = new Set<RestLogLevel>(["debug", "info", "warn", "error"]);

export const DEFAULT_MAX_ROWS = 1000;
export const DEFAULT_MAX_EMBED_DEPTH = 5;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** A configuration failure whose message contains only a public validation rule. */
export class RestConfigError extends Error {
  override readonly name = "RestConfigError";
}

function configError(variable: string, rule: string): Error {
  return new RestConfigError(`${variable} ${rule}`);
}

function parseDatabasePath(value: string | undefined): string {
  const path = value?.trim();

  if (!path) {
    throw configError("DATABASE_PATH", "is required and must not be blank");
  }

  if (
    path !== ":memory:" &&
    !path.endsWith(".sqlite") &&
    !path.endsWith(".db")
  ) {
    throw configError(
      "DATABASE_PATH",
      "must be :memory: or end in .sqlite or .db",
    );
  }

  return path;
}

function parseHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  const isHostname =
    host.length <= 253 &&
    host.split(".").every((label) => {
      return (
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(label)
      );
    });

  if (host.trim() !== host || (isIP(host) === 0 && !isHostname)) {
    throw configError("HOST", "must be a hostname or IP address");
  }

  return host;
}

function parseInteger(
  env: Environment,
  variable: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[variable];

  if (value === undefined) return defaultValue;

  if (!/^\d+$/u.test(value)) {
    throw configError(
      variable,
      `must be a base-10 integer between ${minimum} and ${maximum}`,
    );
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configError(
      variable,
      `must be a base-10 integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function parseCorsOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);

  const origins = new Set<string>();

  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    let url: URL;

    try {
      url = new URL(candidate);
    } catch {
      throw configError(
        "CORS_ORIGINS",
        "must contain only comma-separated HTTP(S) origins",
      );
    }

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin === "null"
    ) {
      throw configError(
        "CORS_ORIGINS",
        "must contain only comma-separated HTTP(S) origins",
      );
    }

    origins.add(url.origin);
  }

  return Object.freeze([...origins]);
}

function parseLogLevel(value: string | undefined): RestLogLevel {
  const logLevel = value ?? "info";

  if (!LOG_LEVELS.has(logLevel as RestLogLevel)) {
    throw configError("LOG_LEVEL", "must be debug, info, warn, or error");
  }

  return logLevel as RestLogLevel;
}

/** Load and validate one immutable runtime configuration snapshot. */
export function loadConfig(env: Environment = process.env): RestConfig {
  const apiKey = env.SETUPLESS_REST_API_KEY?.trim();
  const config: RestConfig = {
    databasePath: parseDatabasePath(env.DATABASE_PATH),
    host: parseHost(env.HOST),
    port: parseInteger(env, "PORT", 3000, 1, 65_535),
    ...(apiKey ? { apiKey } : {}),
    maxRows: parseInteger(env, "MAX_ROWS", DEFAULT_MAX_ROWS, 1, 1_000_000),
    maxEmbedDepth: parseInteger(
      env,
      "MAX_EMBED_DEPTH",
      DEFAULT_MAX_EMBED_DEPTH,
      0,
      20,
    ),
    maxBodyBytes: parseInteger(
      env,
      "MAX_BODY_BYTES",
      DEFAULT_MAX_BODY_BYTES,
      1,
      1_073_741_824,
    ),
    busyTimeoutMs: parseInteger(
      env,
      "SQLITE_BUSY_TIMEOUT_MS",
      5000,
      0,
      600_000,
    ),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };

  return Object.freeze(config);
}
