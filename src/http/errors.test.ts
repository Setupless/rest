import { describe, expect, it } from "bun:test";

import {
  createRestError,
  REST_ERROR_DEFINITIONS,
  RestError,
  toErrorResponse,
} from "./errors";

const expectedRegistry = {
  SLREST100: [400, "Malformed request"],
  SLREST101: [400, "Unknown column"],
  SLREST102: [400, "Invalid filter"],
  SLREST103: [400, "Invalid query controls"],
  SLREST104: [400, "Invalid preference"],
  SLREST105: [415, "Unsupported media type"],
  SLREST106: [406, "Singular result required"],
  SLREST107: [400, "Invalid JSON payload"],
  SLREST108: [413, "Request body too large"],
  SLREST109: [416, "Invalid item range"],
  SLREST110: [400, "Maximum nesting depth exceeded"],
  SLREST111: [400, "Maximum affected rows exceeded"],
  SLREST112: [400, "Invalid PUT identity"],
  SLREST113: [400, "Invalid conflict target"],
  SLREST200: [404, "Resource not found"],
  SLREST202: [400, "Relationship not found"],
  SLREST203: [300, "Multiple Choices"],
  SLREST204: [405, "Method not allowed"],
  SLREST206: [400, "Column is not writable"],
  SLREST207: [400, "Mutation order is not deterministic"],
  SLREST300: [401, "Bearer credentials required"],
  SLREST301: [401, "Invalid bearer credentials"],
  SLREST302: [401, "Authorization required"],
  SLREST303: [403, "Operation forbidden"],
  SLREST304: [500, "Authorization failed safely"],
  SLREST305: [403, "Cross-origin request forbidden"],
  SLREST400: [409, "Unique constraint conflict"],
  SLREST401: [409, "Foreign key conflict"],
  SLREST402: [400, "Constraint violation"],
  SLREST403: [400, "Invalid value"],
  SLREST405: [403, "New row violates authorization"],
  SLREST406: [409, "Stored row identity is not stable"],
  SLREST500: [500, "Internal server error"],
  SLREST501: [500, "Stored value is invalid"],
  SLREST502: [503, "Database is busy"],
  SLREST503: [503, "Database is unavailable"],
  SLREST504: [500, "Response serialization failed"],
} as const;

describe("RestError", () => {
  it("defines every controlled 0.1 error with its stable status and message", () => {
    expect(Object.keys(REST_ERROR_DEFINITIONS)).toEqual(
      Object.keys(expectedRegistry),
    );
    for (const code of Object.keys(
      REST_ERROR_DEFINITIONS,
    ) as (keyof typeof REST_ERROR_DEFINITIONS)[]) {
      expect(REST_ERROR_DEFINITIONS[code].status).toBe(
        expectedRegistry[code][0],
      );
      expect(REST_ERROR_DEFINITIONS[code].message).toBe(
        expectedRegistry[code][1],
      );
    }
    expect(Object.isFrozen(REST_ERROR_DEFINITIONS)).toBe(true);
    expect(Object.values(REST_ERROR_DEFINITIONS).every(Object.isFrozen)).toBe(
      true,
    );
  });

  it("constructs every registry entry through one status-safe factory", () => {
    for (const code of Object.keys(
      REST_ERROR_DEFINITIONS,
    ) as (keyof typeof REST_ERROR_DEFINITIONS)[]) {
      const error = createRestError(code);

      expect(error).toBeInstanceOf(RestError);
      expect(error).toMatchObject({
        code,
        status: REST_ERROR_DEFINITIONS[code].status,
        message: REST_ERROR_DEFINITIONS[code].message,
        details: null,
        hint: null,
      });
    }
  });
});

describe("toErrorResponse", () => {
  it("serializes exactly the controlled envelope and required headers", async () => {
    const response = toErrorResponse(
      createRestError("SLREST101", {
        details: 'Column "missing" does not exist on resource "tasks".',
      }),
      "request-123",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBe("request-123");
    expect(await response.json()).toEqual({
      code: "SLREST101",
      message: "Unknown column",
      details: 'Column "missing" does not exist on resource "tasks".',
      hint: null,
    });
  });

  it.each(["SLREST300", "SLREST301", "SLREST302"] as const)(
    "adds the bearer challenge for %s",
    (code) => {
      expect(
        toErrorResponse(createRestError(code), "request-123").headers.get(
          "WWW-Authenticate",
        ),
      ).toBe("Bearer");
    },
  );

  it("adds the retry header only to the database-busy error", () => {
    expect(
      toErrorResponse(createRestError("SLREST502"), "request-123").headers.get(
        "Retry-After",
      ),
    ).toBe("1");
    expect(
      toErrorResponse(createRestError("SLREST503"), "request-123").headers.get(
        "Retry-After",
      ),
    ).toBeNull();
  });

  it("copies only status-appropriate supplemental contract headers", () => {
    const methodResponse = toErrorResponse(
      createRestError("SLREST204", {
        headers: { Allow: "GET, HEAD, OPTIONS" },
      }),
      "request-123",
    );
    const rangeResponse = toErrorResponse(
      createRestError("SLREST109", {
        headers: { "Content-Range": "*/4" },
      }),
      "request-123",
    );
    const unrelatedResponse = toErrorResponse(
      createRestError("SLREST101", {
        headers: {
          Allow: "DELETE",
          Authorization: "Bearer do-not-disclose",
          "Content-Range": "*/4",
        },
      }),
      "request-123",
    );

    expect(methodResponse.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(rangeResponse.headers.get("Content-Range")).toBe("*/4");
    expect(unrelatedResponse.headers.get("Allow")).toBeNull();
    expect(unrelatedResponse.headers.get("Content-Range")).toBeNull();
    expect(unrelatedResponse.headers.get("Authorization")).toBeNull();
  });

  it("sanitizes unexpected errors and invalid request IDs", async () => {
    const canary =
      "SELECT secret FROM credentials at /private/operator/database.sqlite";
    const response = toErrorResponse(new Error(canary), canary);
    const body = await response.text();
    const responseRequestId = response.headers.get("X-Request-Id");

    expect(response.status).toBe(500);
    expect(responseRequestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(responseRequestId).not.toContain(canary);
    expect(body).toBe(
      JSON.stringify({
        code: "SLREST500",
        message: "Internal server error",
        details: null,
        hint: `Contact the operator with request ID ${responseRequestId}.`,
      }),
    );
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("/private");
    expect(body).not.toContain("Error");
  });

  it("adds request-ID guidance to an explicitly controlled SLREST500", async () => {
    const response = toErrorResponse(
      createRestError("SLREST500"),
      "request-123",
    );

    expect(await response.json()).toEqual({
      code: "SLREST500",
      message: "Internal server error",
      details: null,
      hint: "Contact the operator with request ID request-123.",
    });
  });

  it("serializes the registry message even if Error.message is mutated", async () => {
    const error = createRestError("SLREST101");
    error.message = "SELECT a secret from /private/database.sqlite";

    expect(await toErrorResponse(error, "request-123").json()).toEqual({
      code: "SLREST101",
      message: "Unknown column",
      details: null,
      hint: null,
    });
  });
});
