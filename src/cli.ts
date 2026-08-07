import { createApiKeyAuth } from "./auth/api-key";
import { loadConfig, RestConfigError } from "./config";
import { createJsonLogger } from "./logging/logger";
import { serveRest } from "./server";

const MISSING_API_KEY_MESSAGE =
  "SETUPLESS_REST_API_KEY is required and must not be blank";

/** Returns only canonical public startup failures to the stock CLI log. */
export function safeStartupMessage(error: unknown): string {
  if (
    error instanceof RestConfigError ||
    (error instanceof Error && error.message === MISSING_API_KEY_MESSAGE)
  ) {
    return error.message;
  }
  return "Setupless/rest failed to start";
}

if (import.meta.main) {
  try {
    const config = loadConfig();

    if (!config.apiKey) {
      throw Error(MISSING_API_KEY_MESSAGE);
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
