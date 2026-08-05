import { describe, expect, it } from "bun:test";
import { FILTER_RESOURCE } from "../../test/filter-fixture";
import { RestError } from "../http/errors";
import { parseRestFilters } from "./filter-parser";

function params(name: string, value: string): URLSearchParams {
  return new URLSearchParams([[name, value]]);
}

describe("parseRestFilters", () => {
  it.each([
    ["id", "eq.1", { field: "id", operator: "eq", value: 1 }],
    ["id", "neq.1", { field: "id", operator: "neq", value: 1 }],
    ["id", "gt.1", { field: "id", operator: "gt", value: 1 }],
    ["id", "gte.1", { field: "id", operator: "gte", value: 1 }],
    ["id", "lt.2", { field: "id", operator: "lt", value: 2 }],
    ["id", "lte.2", { field: "id", operator: "lte", value: 2 }],
    [
      "title",
      "like.*contract",
      { field: "title", operator: "like", value: "*contract" },
    ],
    [
      "title",
      "ilike.write*",
      { field: "title", operator: "ilike", value: "write*" },
    ],
    ["id", "in.(1,2)", { field: "id", operator: "in", value: [1, 2] }],
    ["payload", "is.null", { field: "payload", operator: "is", value: null }],
    ["done", "is.false", { field: "done", operator: "is", value: false }],
  ] as const)("parses %s=%s", (name, value, expected) => {
    expect(parseRestFilters(params(name, value), FILTER_RESOURCE)).toEqual(
      expected,
    );
  });

  it("combines repeated and distinct scalar parameters with AND", () => {
    const searchParams = new URLSearchParams();
    searchParams.append("id", "gte.1");
    searchParams.append("id", "lte.3");
    searchParams.append("done", "is.false");

    expect(parseRestFilters(searchParams, FILTER_RESOURCE)).toEqual({
      and: [
        { field: "id", operator: "gte", value: 1 },
        { field: "id", operator: "lte", value: 3 },
        { field: "done", operator: "is", value: false },
      ],
    });
  });

  it("parses scalar negation and recursively nested Boolean groups", () => {
    expect(
      parseRestFilters(
        params("or", "(id.eq.1,and(title.like.*contract,not(done.is.true)))"),
        FILTER_RESOURCE,
      ),
    ).toEqual({
      or: [
        { field: "id", operator: "eq", value: 1 },
        {
          and: [
            { field: "title", operator: "like", value: "*contract" },
            { not: { field: "done", operator: "is", value: true } },
          ],
        },
      ],
    });
    expect(
      parseRestFilters(params("done", "not.is.true"), FILTER_RESOURCE),
    ).toEqual({ not: { field: "done", operator: "is", value: true } });
  });

  it("parses quoted in values with commas, reserved characters, and escapes", () => {
    const filter = parseRestFilters(
      params(
        "title",
        String.raw`in.("Ship, maybe","a&(b)=c","say \"hello\"","path\\file", unquoted )`,
      ),
      FILTER_RESOURCE,
    );

    expect(filter).toEqual({
      field: "title",
      operator: "in",
      value: [
        "Ship, maybe",
        "a&(b)=c",
        'say "hello"',
        "path\\file",
        "unquoted",
      ],
    });
    expect(Object.isFrozen(filter)).toBe(true);
    expect(
      Object.isFrozen((filter as { value: readonly string[] }).value),
    ).toBe(true);
  });

  it("coerces schema-aware scalar values without losing precision", () => {
    expect(
      parseRestFilters(
        new URLSearchParams([
          ["id", "eq.9223372036854775807"],
          ["ratio", "eq.1.25"],
          ["amount", "eq.retained text"],
          ["bytes", "eq.\\xDeAdBeEf"],
        ]),
        FILTER_RESOURCE,
      ),
    ).toEqual({
      and: [
        { field: "id", operator: "eq", value: "9223372036854775807" },
        { field: "ratio", operator: "eq", value: 1.25 },
        { field: "amount", operator: "eq", value: "retained text" },
        { field: "bytes", operator: "eq", value: "\\xdeadbeef" },
      ],
    });
  });

  it("ignores query controls owned by the query parser", () => {
    expect(
      parseRestFilters(
        new URLSearchParams("select=id,title&order=id.asc&limit=1&offset=0"),
        FILTER_RESOURCE,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["id", "bogus.1"],
    ["id", "eq"],
    ["id", "eq.1.5"],
    ["ratio", "eq.0.10000000000000001"],
    ["title", "in.()"],
    ["title", "in.(one,)"],
    ["title", String.raw`in.("bad\q")`],
    ["done", "is.1"],
    ["id", "like.1*"],
    ["and", "()"],
    ["not", "(id.eq.1,id.eq.2)"],
  ] as const)("rejects malformed %s=%s filters", (name, value) => {
    expect(() =>
      parseRestFilters(params(name, value), FILTER_RESOURCE),
    ).toThrow(expect.objectContaining({ code: "SLREST102" }));
  });

  it("uses the stable unknown-column error without treating input as SQL", () => {
    try {
      parseRestFilters(
        params('id"; DROP TABLE records; --', "eq.1"),
        FILTER_RESOURCE,
      );
      throw Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestError);
      expect((error as RestError).code).toBe("SLREST101");
    }
  });

  it("enforces the configured Boolean nesting limit", () => {
    expect(() =>
      parseRestFilters(
        params("not", "(not(not(id.eq.1)))"),
        FILTER_RESOURCE,
        2,
      ),
    ).toThrow(expect.objectContaining({ code: "SLREST110" }));
  });
});
