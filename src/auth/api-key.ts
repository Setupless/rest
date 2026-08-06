import { createHash, timingSafeEqual } from "node:crypto";
import { RestError } from "../http/errors";
import type {
  AuthorizationDecision,
  RestAuthorizationContext,
  RestAuthPlugin,
} from "./types";

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const AUTHORIZATION_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/iu;
const ALLOWED = Object.freeze({
  allowed: true,
}) satisfies AuthorizationDecision;
const apiKeyPlugins = new WeakSet<RestAuthPlugin>();
const apiKeyErrors = new WeakSet<RestError>();

function authenticationError(
  code: "SLREST300" | "SLREST301",
): RestError<"SLREST300" | "SLREST301"> {
  const error = new RestError(code, {
    ...(code === "SLREST300"
      ? { hint: "Send one Authorization: Bearer <token> header." }
      : {}),
  });
  apiKeyErrors.add(error);
  return error;
}

function digestCredential(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/** @internal Identifies the stock plugin without exposing its credential. */
export function isApiKeyAuth(plugin: RestAuthPlugin): boolean {
  return apiKeyPlugins.has(plugin);
}

/** @internal Allows only stock authentication failures through the plugin guard. */
export function isApiKeyAuthError(error: unknown): error is RestError {
  return error instanceof RestError && apiKeyErrors.has(error);
}

/** Creates the stock timing-safe Bearer API-key plugin. */
export function createApiKeyAuth(apiKey: string): RestAuthPlugin {
  if (typeof apiKey !== "string" || !BEARER_TOKEN_PATTERN.test(apiKey)) {
    throw new TypeError("apiKey must be a non-empty Bearer token");
  }

  const expectedDigest = digestCredential(apiKey);
  const plugin: RestAuthPlugin = {
    authorize({ request }: RestAuthorizationContext) {
      const authorization = request.headers.get("Authorization");
      const match =
        authorization === null
          ? null
          : AUTHORIZATION_PATTERN.exec(authorization);

      if (!match) throw authenticationError("SLREST300");

      const token = match[1];
      if (
        token === undefined ||
        !timingSafeEqual(digestCredential(token), expectedDigest)
      ) {
        throw authenticationError("SLREST301");
      }

      return ALLOWED;
    },
  };
  Object.freeze(plugin);
  apiKeyPlugins.add(plugin);
  return plugin;
}
