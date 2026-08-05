import { describe, expect, it } from "bun:test";
import { FILTER_RESOURCE } from "../../test/filter-fixture";
import { useTestFixture } from "../../test/fixtures";
import type { RestFilter } from "./filter";
import { compileRestFilter } from "./filter-compiler";
import { parseRestFilters } from "./filter-parser";

describe("compileRestFilter", () => {
  it.each([
    ["eq", "=", 1],
    ["neq", "<>", 1],
    ["gt", ">", 1],
    ["gte", ">=", 1],
    ["lt", "<", 1],
    ["lte", "<=", 1],
  ] as const)(
    "compiles %s through one bound parameter",
    (operator, sql, value) => {
      expect(
        compileRestFilter(
          { field: "id", operator, value },
          FILTER_RESOURCE,
          "record",
        ),
      ).toEqual({ sql: `"record"."id" ${sql} ?`, parameters: [value] });
    },
  );

  it("compiles null, Boolean, in, like, and ilike semantics", () => {
    expect(
      compileRestFilter(
        { field: "payload", operator: "is", value: null },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({ sql: '"r"."payload" IS ?', parameters: [null] });
    expect(
      compileRestFilter(
        { field: "done", operator: "is", value: false },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({ sql: '"r"."done" IS ?', parameters: [false] });
    expect(
      compileRestFilter(
        { field: "id", operator: "in", value: [1, 2] },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({ sql: '"r"."id" IN (?, ?)', parameters: [1, 2] });
    expect(
      compileRestFilter(
        { field: "title", operator: "like", value: "*contract_100%" },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({
      sql: '"r"."title" LIKE ?',
      parameters: ["%contract_100%"],
    });
    expect(
      compileRestFilter(
        { field: "title", operator: "ilike", value: "write*" },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({
      sql: '"r"."title" LIKE ? COLLATE NOCASE',
      parameters: ["write%"],
    });
  });

  it("decodes bound public BLOB values inside SQLite", () => {
    expect(
      compileRestFilter(
        { field: "bytes", operator: "eq", value: "\\x00a5ff" },
        FILTER_RESOURCE,
        "r",
      ),
    ).toEqual({
      sql: '"r"."bytes" = unhex(substr(?, 3))',
      parameters: ["\\x00a5ff"],
    });
  });

  it("preserves Boolean precedence and parameter order", () => {
    const filter: RestFilter = {
      and: [
        { field: "id", operator: "gte", value: 1 },
        {
          or: [
            { field: "title", operator: "eq", value: "first" },
            { not: { field: "done", operator: "is", value: true } },
          ],
        },
      ],
    };

    expect(compileRestFilter(filter, FILTER_RESOURCE, "r")).toEqual({
      sql: '("r"."id" >= ?) AND (("r"."title" = ?) OR (NOT ("r"."done" IS ?)))',
      parameters: [1, "first", true],
    });
  });

  it("uses canonical schema fields and safely quotes the generated alias", () => {
    expect(
      compileRestFilter(
        { field: 'ODD"NAME', operator: "eq", value: "safe" },
        FILTER_RESOURCE,
        'r" WHERE 1=1 --',
      ),
    ).toEqual({
      sql: '"r"" WHERE 1=1 --"."odd""name" = ?',
      parameters: ["safe"],
    });
  });

  it("returns an immutable compilation result", () => {
    const compiled = compileRestFilter(
      { field: "id", operator: "eq", value: 1 },
      FILTER_RESOURCE,
      "r",
    );

    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.parameters)).toBe(true);
  });

  it("compiles equivalent URL and programmatic filters identically", () => {
    const parsed = parseRestFilters(
      new URLSearchParams("id=gte.2"),
      FILTER_RESOURCE,
    );
    if (!parsed) throw Error("expected a parsed filter");

    expect(compileRestFilter(parsed, FILTER_RESOURCE, "r")).toEqual(
      compileRestFilter(
        { field: "id", operator: "gte", value: 2 },
        FILTER_RESOURCE,
        "r",
      ),
    );
  });

  describe("against SQLite", () => {
    const fixture = useTestFixture();

    it("binds hostile values instead of changing the SQL program", () => {
      const users = fixture.schema.getResource("users");
      if (!users) throw Error("users fixture is unavailable");
      const filter = parseRestFilters(
        new URLSearchParams([["name", "eq.Alice' OR 1=1 --"]]),
        users,
      );
      if (!filter) throw Error("expected a parsed filter");
      const compiled = compileRestFilter(filter, users, "u");

      const rows = fixture.database
        .query<Record<string, unknown>, string[]>(
          `SELECT "u"."id" FROM "users" AS "u" WHERE ${compiled.sql}`,
        )
        .all(...(compiled.parameters as string[]));

      expect(rows).toEqual([]);
      expect(compiled.sql).not.toContain("Alice");
    });

    it("rejects hostile fields before a statement can be prepared", () => {
      const users = fixture.schema.getResource("users");
      if (!users) throw Error("users fixture is unavailable");

      expect(() =>
        compileRestFilter(
          {
            field: 'name"; DROP TABLE users; --',
            operator: "eq",
            value: "Alice Johnson",
          },
          users,
          "u",
        ),
      ).toThrow(expect.objectContaining({ code: "SLREST101" }));
      expect(
        fixture.database.query("SELECT count(*) AS count FROM users").get(),
      ).toEqual({ count: 3 });
    });
  });
});
