import { describe, expect, it } from "bun:test";
import { TASKS } from "../../test/query-fixture";
import { RestError } from "../http/errors";
import { parseRestOrder } from "./order-parser";

function expectCode(parameters: string, code: RestError["code"]): void {
  try {
    parseRestOrder(new URLSearchParams(parameters), TASKS);
    throw new Error("Expected parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).code).toBe(code);
  }
}

describe("parseRestOrder", () => {
  it("parses direction and null placement with immutable canonical fields", () => {
    const order = parseRestOrder(
      new URLSearchParams(
        "order=priority.desc.nullslast,id.asc,odd.name.nullsfirst",
      ),
      TASKS,
    );

    expect(order).toEqual([
      { field: "priority", direction: "desc", nulls: "last" },
      { field: "id", direction: "asc" },
      { field: "odd.name", direction: "asc", nulls: "first" },
    ]);
    expect(Object.isFrozen(order)).toBe(true);
    expect(order.every(Object.isFrozen)).toBe(true);
  });

  it("resolves SQLite identifiers case-insensitively", () => {
    expect(
      parseRestOrder(new URLSearchParams("order=TITLE.desc"), TASKS),
    ).toEqual([{ field: "title", direction: "desc" }]);
  });

  it("rejects duplicate parameters and fields", () => {
    expectCode("order=id&order=title", "SLREST103");
    expectCode("order=id.asc,ID.desc", "SLREST103");
  });

  it("rejects malformed and unknown order terms safely", () => {
    expectCode("order=", "SLREST103");
    expectCode("order=id,", "SLREST103");
    expectCode("order= id", "SLREST103");
    expectCode("order=missing.desc", "SLREST101");
  });
});
