const definitions = {
  SLREST100: { status: 400, message: "Malformed request" },
  SLREST101: { status: 400, message: "Unknown column" },
  SLREST102: { status: 400, message: "Invalid filter" },
  SLREST103: { status: 400, message: "Invalid query controls" },
  SLREST104: { status: 400, message: "Invalid preference" },
  SLREST105: { status: 415, message: "Unsupported media type" },
  SLREST106: { status: 406, message: "Singular result required" },
  SLREST107: { status: 400, message: "Invalid JSON payload" },
  SLREST108: { status: 413, message: "Request body too large" },
  SLREST109: { status: 416, message: "Invalid item range" },
  SLREST110: { status: 400, message: "Maximum nesting depth exceeded" },
  SLREST111: { status: 400, message: "Maximum affected rows exceeded" },
  SLREST112: { status: 400, message: "Invalid PUT identity" },
  SLREST113: { status: 400, message: "Invalid conflict target" },
  SLREST200: { status: 404, message: "Resource not found" },
  SLREST202: { status: 400, message: "Relationship not found" },
  SLREST203: { status: 300, message: "Multiple Choices" },
  SLREST204: { status: 405, message: "Method not allowed" },
  SLREST206: { status: 400, message: "Column is not writable" },
  SLREST207: {
    status: 400,
    message: "Mutation order is not deterministic",
  },
  SLREST300: { status: 401, message: "Bearer credentials required" },
  SLREST301: { status: 401, message: "Invalid bearer credentials" },
  SLREST302: { status: 401, message: "Authorization required" },
  SLREST303: { status: 403, message: "Operation forbidden" },
  SLREST304: { status: 500, message: "Authorization failed safely" },
  SLREST305: { status: 403, message: "Cross-origin request forbidden" },
  SLREST400: { status: 409, message: "Unique constraint conflict" },
  SLREST401: { status: 409, message: "Foreign key conflict" },
  SLREST402: { status: 400, message: "Constraint violation" },
  SLREST403: { status: 400, message: "Invalid value" },
  SLREST405: { status: 403, message: "New row violates authorization" },
  SLREST406: { status: 409, message: "Stored row identity is not stable" },
  SLREST500: { status: 500, message: "Internal server error" },
  SLREST501: { status: 500, message: "Stored value is invalid" },
  SLREST502: { status: 503, message: "Database is busy" },
  SLREST503: { status: 503, message: "Database is unavailable" },
  SLREST504: { status: 500, message: "Response serialization failed" },
} as const satisfies Record<
  `SLREST${number}`,
  Readonly<{ status: number; message: string }>
>;

for (const definition of Object.values(definitions)) {
  Object.freeze(definition);
}

/** The complete controlled-error registry for the 0.1 HTTP contract. */
export const REST_ERROR_DEFINITIONS = Object.freeze(definitions);

export type RestErrorCode = keyof typeof REST_ERROR_DEFINITIONS;

type RestHeadersInit = ConstructorParameters<typeof Headers>[0];

export interface RestErrorOptions {
  readonly details?: string | null;
  readonly hint?: string | null;
  /** Additional contract headers such as Allow or Content-Range. */
  readonly headers?: RestHeadersInit;
}

/** A controlled failure safe for the public HTTP error envelope. */
export class RestError<
  Code extends RestErrorCode = RestErrorCode,
> extends Error {
  readonly code: Code;
  readonly status: (typeof REST_ERROR_DEFINITIONS)[Code]["status"];
  readonly details: string | null;
  readonly hint: string | null;
  readonly headers: Headers;

  constructor(code: Code, options: RestErrorOptions = {}) {
    const definition = REST_ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "RestError";
    this.code = code;
    this.status = definition.status;
    this.details = options.details ?? null;
    this.hint = options.hint ?? null;
    this.headers = new Headers(options.headers);
  }
}

/** Creates a registry-backed error without allowing status/message drift. */
export function createRestError<Code extends RestErrorCode>(
  code: Code,
  options?: RestErrorOptions,
): RestError<Code> {
  return new RestError(code, options);
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CONTENT_TYPE = "application/json; charset=utf-8";

function getSafeRequestId(requestId: string): string {
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : crypto.randomUUID();
}

function copyContractHeaders(error: RestError, headers: Headers): void {
  if (error.status === 405) {
    const allow = error.headers.get("Allow");
    if (allow !== null) headers.set("Allow", allow);
  }

  if (error.status === 416) {
    const contentRange = error.headers.get("Content-Range");
    if (contentRange !== null) headers.set("Content-Range", contentRange);
  }
}

/** Serializes controlled failures and safely maps every other value to SLREST500. */
export function toErrorResponse(error: unknown, requestId: string): Response {
  const safeRequestId = getSafeRequestId(requestId);
  const controlledError: RestError =
    error instanceof RestError
      ? error
      : new RestError("SLREST500", {
          hint: `Contact the operator with request ID ${safeRequestId}.`,
        });
  const hint =
    controlledError.code === "SLREST500" && controlledError.hint === null
      ? `Contact the operator with request ID ${safeRequestId}.`
      : controlledError.hint;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": ERROR_CONTENT_TYPE,
    "X-Request-Id": safeRequestId,
  });

  copyContractHeaders(controlledError, headers);
  if (controlledError.status === 401) {
    headers.set("WWW-Authenticate", "Bearer");
  }
  if (controlledError.code === "SLREST502") {
    headers.set("Retry-After", "1");
  }

  return new Response(
    JSON.stringify({
      code: controlledError.code,
      message: REST_ERROR_DEFINITIONS[controlledError.code].message,
      details: controlledError.details,
      hint,
    }),
    { status: controlledError.status, headers },
  );
}
