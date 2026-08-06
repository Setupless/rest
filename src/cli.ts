import { createApiKeyAuth } from "./auth/api-key";
import { loadConfig } from "./config";
import { serveRest } from "./server";

if (import.meta.main) {
  try {
    const config = loadConfig();

    if (!config.apiKey) {
      throw Error("SETUPLESS_REST_API_KEY is required and must not be blank");
    }

    await serveRest({ config, auth: createApiKeyAuth(config.apiKey) });
  } catch (error) {
    console.error("Failed to start Setupless/rest", error);
    process.exitCode = 1;
  }
}
