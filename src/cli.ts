import { createApiKeyAuth } from "./auth/api-key";
import { loadConfig } from "./config";
import { createJsonLogger } from "./logging/logger";
import { serveRest } from "./server";

const SAFE_STARTUP_MESSAGE =
  /^(?:DATABASE_PATH|HOST|PORT|SETUPLESS_REST_API_KEY|MAX_ROWS|MAX_EMBED_DEPTH|MAX_BODY_BYTES|SQLITE_BUSY_TIMEOUT_MS|CORS_ORIGINS|LOG_LEVEL)\b/u;

function safeStartupMessage(error: unknown): string {
  if (error instanceof Error && SAFE_STARTUP_MESSAGE.test(error.message)) {
    return error.message;
  }
  return "Setupless/rest failed to start";
}

if (import.meta.main) {
  try {
    const config = loadConfig();

    if (!config.apiKey) {
      throw Error("SETUPLESS_REST_API_KEY is required and must not be blank");
    }

    await serveRest({ config, auth: createApiKeyAuth(config.apiKey) });
  } catch (error) {
    createJsonLogger("info").error({
      event: "server.start_failed",
      message: safeStartupMessage(error),
    });
    process.exitCode = 1;
  }
}
