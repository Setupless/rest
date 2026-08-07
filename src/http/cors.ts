import { RestError } from "./errors";

const EXPOSED_HEADERS =
  "Content-Range, Range-Unit, Preference-Applied, Location, Retry-After, X-Request-Id";
const ALLOWED_REQUEST_HEADERS = new Map([
  ["authorization", "Authorization"],
  ["content-type", "Content-Type"],
  ["prefer", "Prefer"],
  ["range", "Range"],
  ["range-unit", "Range-Unit"],
  ["x-request-id", "X-Request-Id"],
]);
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

export interface CorsRequest {
  readonly origin: string;
  readonly preflight: boolean;
  readonly requestedMethod?: string;
  readonly requestedHeaders: readonly string[];
}

function forbidden(): RestError<"SLREST305"> {
  return new RestError("SLREST305", {
    hint: "Ask the operator to allow this browser origin, method, and header set.",
  });
}

function parseRequestedHeaders(value: string | null): readonly string[] {
  if (value === null || value.trim() === "") return Object.freeze([]);
  const headers: string[] = [];
  const seen = new Set<string>();

  for (const entry of value.split(",")) {
    const name = entry.trim().toLowerCase();
    const canonical = ALLOWED_REQUEST_HEADERS.get(name);
    if (!TOKEN_PATTERN.test(name) || canonical === undefined) throw forbidden();
    if (!seen.has(name)) {
      seen.add(name);
      headers.push(canonical);
    }
  }
  return Object.freeze(headers);
}

/** Validates the origin and preflight fields without exposing configuration. */
export function resolveCorsRequest(
  request: Request,
  allowedOrigins: readonly string[],
): CorsRequest | undefined {
  const origin = request.headers.get("Origin");
  if (origin === null) return undefined;
  if (!allowedOrigins.includes(origin)) throw forbidden();

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  const preflight = request.method === "OPTIONS" && requestedMethod !== null;
  if (preflight && !TOKEN_PATTERN.test(requestedMethod)) throw forbidden();

  return Object.freeze({
    origin,
    preflight,
    ...(preflight ? { requestedMethod } : {}),
    requestedHeaders: preflight
      ? parseRequestedHeaders(
          request.headers.get("Access-Control-Request-Headers"),
        )
      : Object.freeze([]),
  });
}

function appendVaryOrigin(headers: Headers): void {
  const vary = headers.get("Vary");
  if (vary === null) {
    headers.set("Vary", "Origin");
    return;
  }
  if (
    !vary.split(",").some((value) => value.trim().toLowerCase() === "origin")
  ) {
    headers.set("Vary", `${vary}, Origin`);
  }
}

/** Adds the approved response headers and validates a route-aware preflight. */
export function applyCorsHeaders(
  response: Response,
  cors: CorsRequest | undefined,
): Response {
  if (cors === undefined) return response;

  const headers = new Headers(response.headers);
  if (cors.preflight) {
    const allow = headers.get("Allow");
    const methods = allow?.split(",").map((method) => method.trim()) ?? [];
    if (
      cors.requestedMethod === undefined ||
      !methods.includes(cors.requestedMethod)
    ) {
      throw forbidden();
    }
    headers.set("Access-Control-Allow-Methods", methods.join(", "));
    if (cors.requestedHeaders.length > 0) {
      headers.set(
        "Access-Control-Allow-Headers",
        cors.requestedHeaders.join(", "),
      );
    }
  }

  headers.set("Access-Control-Allow-Origin", cors.origin);
  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  appendVaryOrigin(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
