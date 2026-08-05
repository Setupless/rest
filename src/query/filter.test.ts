import { describe, expect, it } from "bun:test";
import { FILTER_RESOURCE } from "../../test/filter-fixture";
import { RestError } from "../http/errors";
import { andFilters, type RestFilter, validateRestFilter } from "./filter";

describe("validateRestFilter", () => {
  it.each([
    { field: "ID", operator: "eq", value: 1 },
    { field: "id", operator: "in", value: [1, "9223372036854775807"] },
    { field: "ratio", operator: "gte", value: 1.25 },
    { field: "title", operator: "like", value: "*contract" },
    { field: "done", operator: "is", value: false },
    { field: "amount", operator: "eq", value: "retained text" },
    { field: "bytes", operator: "eq", value: "\\x00a5ff" },
    { field: "payload", operator: "eq", value: '{"ok":true}' },
    { not: { field: "id", operator: "eq", value: 1 } },
    {
      or: [
        { field: "id", operator: "eq", value: 1 },
        { field: "id", operator: "eq", value: 2 },
      ],
    },
  ] as const)("accepts a schema-compatible AST %#", (filter) => {
    expect(() =>
      validateRestFilter(filter as RestFilter, FILTER_RESOURCE),
    ).not.toThrow();
  });

  it.each([
    [{ field: "missing", operator: "eq", value: 1 }, "SLREST101"],
    [{ field: "id", operator: "like", value: "1*" }, "SLREST102"],
    [{ field: "id", operator: "eq", value: 1.5 }, "SLREST102"],
    [
      { field: "ratio", operator: "eq", value: Number.POSITIVE_INFINITY },
      "SLREST102",
    ],
    [{ field: "done", operator: "eq", value: 1 }, "SLREST102"],
    [{ field: "title", operator: "is", value: false }, "SLREST102"],
    [{ field: "title", operator: "in", value: [] }, "SLREST102"],
    [{ field: "title", operator: "eq", value: ["value"] }, "SLREST102"],
    [{ and: [] }, "SLREST102"],
    [{ field: "id", operator: "eq", value: 1, rawSql: "1=1" }, "SLREST102"],
  ] as const)("rejects an invalid plugin AST %#", (filter, code) => {
    try {
      validateRestFilter(filter as unknown as RestFilter, FILTER_RESOURCE);
      throw Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestError);
      expect((error as RestError).code).toBe(code);
    }
  });

  it("rejects cyclic plugin filters without recursing indefinitely", () => {
    const cyclic: { not?: unknown } = {};
    cyclic.not = cyclic;

    expect(() =>
      validateRestFilter(cyclic as RestFilter, FILTER_RESOURCE),
    ).toThrow(expect.objectContaining({ code: "SLREST102" }));
  });

  it("applies the configured depth to plugin-created Boolean nodes", () => {
    const filter: RestFilter = {
      not: { not: { field: "id", operator: "eq", value: 1 } },
    };

    expect(() => validateRestFilter(filter, FILTER_RESOURCE, 1)).toThrow(
      expect.objectContaining({ code: "SLREST110" }),
    );
  });

  it("rejects an invalid configured depth as a programmer error", () => {
    expect(() => validateRestFilter({ and: [] }, FILTER_RESOURCE, -1)).toThrow(
      TypeError,
    );
  });
});

describe("andFilters", () => {
  const first: RestFilter = { field: "id", operator: "eq", value: 1 };
  const second: RestFilter = { field: "done", operator: "is", value: false };

  it("omits absent filters and preserves a single filter", () => {
    expect(andFilters(undefined)).toBeUndefined();
    expect(andFilters(undefined, first)).toBe(first);
  });

  it("combines client and plugin filters through an immutable explicit AND", () => {
    const combined = andFilters(first, undefined, second);

    expect(combined).toEqual({ and: [first, second] });
    expect(Object.isFrozen(combined)).toBe(true);
    expect(
      Object.isFrozen((combined as { and: readonly RestFilter[] }).and),
    ).toBe(true);
  });
});
