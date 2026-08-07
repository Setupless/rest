import { SQLiteError } from "bun:sqlite";
import type { RestLogger } from "../logging/logger";
import { limitRequestBody } from "./body-limit";
import { applyCorsHeaders, type CorsRequest, resolveCorsRequest } from "./cors";
import { RestError, type RestErrorCode, toErrorResponse } from "./errors";
import { resolveRequestId } from "./request-id";

export interface OperationalRequestDependencies {
  readonly maxBodyBytes: number;
  readonly corsOrigins: readonly string[];
  readonly logger: RestLogger;
}

type RequestHandler = (
  request: Request,
  requestId: string,
) => Response | Promise<Response>;

function normalizeRoute(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/health/live"
  ) {
    return pathname;
  }
  const segments = pathname.split("/");
  return segments.length === 2 && segments[1] !== "" ? "/:resource" : "/*";
}

function operationalError(error: unknown): RestError {
  if (error instanceof RestError) return error;
  if (error instanceof SQLiteError) {
    if (
      error.code?.startsWith("SQLITE_BUSY") ||
      error.code?.startsWith("SQLITE_LOCKED")
    ) {
      return new RestError("SLREST502", {
        hint: "Retry the request after the indicated delay.",
      });
    }
    return new RestError("SLREST503", {
      hint: "Check the database and contact the operator with the request ID.",
    });
  }
  return new RestError("SLREST500");
}

function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safeLog(
  logger: RestLogger,
  event: Readonly<Record<string, unknown>>,
): void {
  try {
    logger.info(event);
  } catch {
    // A logging backend must not change the HTTP contract.
  }
}

/** Applies the complete operational contract around one application route. */
export function createOperationalRequestHandler(
  dependencies: OperationalRequestDependencies,
  handler: RequestHandler,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request);
    const route = normalizeRoute(request);
    let response: Response;
    let errorCode: RestErrorCode | undefined;
    let cors: CorsRequest | undefined;

    try {
      cors = resolveCorsRequest(request, dependencies.corsOrigins);
      const boundedRequest = await limitRequestBody(
        request,
        dependencies.maxBodyBytes,
      );
      response = await handler(boundedRequest, requestId);
      response = applyCorsHeaders(response, cors);
      response = attachRequestId(response, requestId);
    } catch (error) {
      const mapped = operationalError(error);
      errorCode = mapped.code;
      response = toErrorResponse(mapped, requestId);
      if (mapped.code !== "SLREST305") {
        try {
          response = applyCorsHeaders(response, cors);
        } catch (corsError) {
          const mappedCorsError = operationalError(corsError);
          errorCode = mappedCorsError.code;
          response = toErrorResponse(mappedCorsError, requestId);
        }
      }
    }

    safeLog(
      dependencies.logger,
      Object.freeze({
        event: "request.completed",
        requestId,
        method: request.method,
        route,
        status: response.status,
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(errorCode === undefined ? {} : { errorCode }),
      }),
    );
    return response;
  };
}
