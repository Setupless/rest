import { SQLiteError } from "bun:sqlite";
import type { Database } from "../database/database";
import { RestError } from "../http/errors";
import { getPreferenceApplied, parsePreferences } from "../http/preferences";

export interface HealthResponse {
  readonly status: "ok";
  readonly database: "ready";
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
  if (
    error instanceof SQLiteError &&
    (error.code?.startsWith("SQLITE_BUSY") ||
      error.code?.startsWith("SQLITE_LOCKED"))
  ) {
    throw new RestError("SLREST502", {
      hint: "Retry the request after the indicated delay.",
    });
  }
  throw new RestError("SLREST503", {
    hint: "Check the database and contact the operator with the request ID.",
  });
}

function jsonResponse(
  request: Request,
  value: Readonly<Record<string, string>>,
): Response {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify(value),
    { headers: { "Content-Type": JSON_CONTENT_TYPE } },
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
  return jsonResponse(request, { status: "ok", database: "ready" });
}

/** Process-only liveness probe that deliberately does not access SQLite. */
export function livenessResponse(request: Request): Response {
  assertHealthMethod(request);
  validateHealthPreferences(request);
  return jsonResponse(request, { status: "ok" });
}

/** Unauthenticated OPTIONS response shared by both health endpoints. */
export function healthOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, OPTIONS" },
  });
}
