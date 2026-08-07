const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Returns a safe inbound request ID or creates a new opaque identifier. */
export function resolveRequestId(request: Request): string {
  const supplied = request.headers.get("X-Request-Id");
  return supplied !== null && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

/** Reports whether a value satisfies the public request-ID grammar. */
export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}
