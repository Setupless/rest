import { describe, expect, it } from "bun:test";
import { RestError } from "../http/errors";
import { parsePagination } from "./pagination";

function expectCode(callback: () => unknown, code: RestError["code"]): void {
  try {
    callback();
    throw new Error("Expected parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).code).toBe(code);
  }
}

describe("parsePagination", () => {
  it("parses and clamps query pagination", () => {
    expect(parsePagination(new URLSearchParams(), 100)).toEqual({
      offset: 0,
      limit: 100,
      source: "query",
    });
    expect(
      parsePagination(new URLSearchParams("limit=200&offset=3"), 100),
    ).toEqual({ offset: 3, limit: 100, source: "query" });
    expect(parsePagination(new URLSearchParams("limit=0"), 100)).toEqual({
      offset: 0,
      limit: 0,
      source: "query",
    });
  });

  it.each(["-1", "+1", "1.0", "1e2", " 1", "9007199254740992"])(
    "rejects malformed query pagination %s",
    (value) => {
      expectCode(
        () => parsePagination(new URLSearchParams({ limit: value }), 100),
        "SLREST103",
      );
    },
  );

  it("rejects duplicate query controls", () => {
    expectCode(
      () => parsePagination(new URLSearchParams("limit=1&limit=2"), 100),
      "SLREST103",
    );
  });

  it("parses closed and open item ranges and caps each window", () => {
    expect(
      parsePagination(new URLSearchParams(), 100, {
        headers: new Headers({ Range: "10-19", "Range-Unit": "items" }),
      }),
    ).toEqual({ offset: 10, limit: 10, source: "range" });
    expect(
      parsePagination(new URLSearchParams(), 5, {
        headers: new Headers({ Range: "10-" }),
      }),
    ).toEqual({ offset: 10, limit: 5, source: "range" });
    expect(
      parsePagination(new URLSearchParams(), 5, {
        headers: new Headers({ Range: "0-9007199254740991" }),
      }),
    ).toEqual({ offset: 0, limit: 5, source: "range" });
  });

  it("uses Range over query controls under lenient handling", () => {
    expect(
      parsePagination(new URLSearchParams("limit=1&offset=2"), 100, {
        headers: new Headers({ Range: "8-9" }),
      }),
    ).toEqual({ offset: 8, limit: 2, source: "range" });
    expect(
      parsePagination(new URLSearchParams("limit=malformed&offset=-1"), 100, {
        headers: new Headers({ Range: "8-9" }),
      }),
    ).toEqual({ offset: 8, limit: 2, source: "range" });
  });

  it("rejects Range combined with query controls under strict handling", () => {
    expectCode(
      () =>
        parsePagination(new URLSearchParams("limit=1"), 100, {
          headers: new Headers({ Range: "0-1" }),
          strict: true,
        }),
      "SLREST103",
    );
  });

  it.each([
    { range: "", unit: "items" },
    { range: "-1-2", unit: "items" },
    { range: "1.0-2", unit: "items" },
    { range: "2-1", unit: "items" },
    { range: "0-9007199254740992", unit: "items" },
    { range: "0-1", unit: "bytes" },
  ])("rejects invalid item range %#", ({ range, unit }) => {
    expectCode(
      () =>
        parsePagination(new URLSearchParams(), 100, {
          headers: new Headers({ Range: range, "Range-Unit": unit }),
        }),
      "SLREST109",
    );
  });

  it("allows the items unit without Range while rejecting other units", () => {
    expect(
      parsePagination(new URLSearchParams("limit=2&offset=1"), 100, {
        headers: new Headers({ "Range-Unit": "items" }),
      }),
    ).toEqual({ offset: 1, limit: 2, source: "query" });
    expectCode(
      () =>
        parsePagination(new URLSearchParams(), 100, {
          headers: new Headers({ "Range-Unit": "bytes" }),
        }),
      "SLREST109",
    );
  });
});
