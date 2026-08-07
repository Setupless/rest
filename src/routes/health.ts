import type { Database } from "../database/database";
import { mapDatabaseAvailabilityError } from "../database/errors";
import { RestError } from "../http/errors";
import { getPreferenceApplied, parsePreferences } from "../http/preferences";

export interface HealthResponse {
  readonly status: "ok";
  readonly database: "ready";
}

export interface LivenessResponse {
  readonly status: "ok";
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function assertHealthMethod(request: Request): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new RestError("SLREST204", {
      details: `Method ${request.method} is not available for this health route.`,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  }
}

function validateHealthPreferences(request: Request): void {
  getPreferenceApplied(parsePreferences(request.headers), "health");
}

function databaseUnavailable(error: unknown): never {
  const databaseError = mapDatabaseAvailabilityError(error);
  if (databaseError !== undefined) throw databaseError;
  throw new RestError("SLREST503", {
    hint: "Check the database and contact the operator with the request ID.",
  });
}

function jsonResponse(
  request: Request,
  value: HealthResponse | LivenessResponse,
): Response {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify(value),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": JSON_CONTENT_TYPE,
      },
    },
  );
}

/** Database-backed readiness probe. */
export function readinessResponse(
  request: Request,
  database: Database,
): Response {
  assertHealthMethod(request);
  validateHealthPreferences(request);
  try {
    database
      .query<{ total: number }, []>(
        "SELECT COUNT(*) AS total FROM sqlite_schema",
      )
      .get();
  } catch (error) {
    return databaseUnavailable(error);
  }
  const health: HealthResponse = { status: "ok", database: "ready" };
  return jsonResponse(request, health);
}

/** Process-only liveness probe that deliberately does not access SQLite. */
export function livenessResponse(request: Request): Response {
  assertHealthMethod(request);
  validateHealthPreferences(request);
  const health: LivenessResponse = { status: "ok" };
  return jsonResponse(request, health);
}

/** Unauthenticated OPTIONS response shared by both health endpoints. */
export function healthOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, OPTIONS" },
  });
}
