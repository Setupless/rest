import { describe, expect, it } from "bun:test";
import {
  COMPOSITE_CHILDREN,
  ORDERS,
  QUERY_RELATIONSHIPS,
  QUERY_SCHEMA,
  TASKS,
} from "../../test/query-fixture";
import type { RestError } from "../http/errors";
import { parseRestSelection } from "./select-parser";

function expectCode(
  source: string,
  resource = TASKS,
  maxDepth = 5,
): RestError["code"] {
  try {
    parseRestSelection(
      source,
      resource,
      QUERY_SCHEMA,
      QUERY_RELATIONSHIPS,
      maxDepth,
    );
    throw new Error("Expected parsing to fail");
  } catch (error) {
    return (error as RestError).code;
  }
}

describe("parseRestSelection", () => {
  it("expands wildcards and resolves scalar aliases immediately", () => {
    const all = parseRestSelection(
      "*",
      TASKS,
      QUERY_SCHEMA,
      QUERY_RELATIONSHIPS,
      5,
    );
    const selected = parseRestSelection(
      "task_id:ID,label:title",
      TASKS,
      QUERY_SCHEMA,
      QUERY_RELATIONSHIPS,
      5,
    );

    expect(all.map(({ kind, ...node }) => ({ kind, ...node }))).toHaveLength(
      TASKS.columns.length,
    );
    expect(selected).toMatchObject([
      { kind: "column", column: "id", alias: "task_id" },
      { kind: "column", column: "title", alias: "label" },
    ]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected.every(Object.isFrozen)).toBe(true);
  });

  it("resolves aliased, hinted, recursively nested relations", () => {
    const selection = parseRestSelection(
      "id,project:projects!project_id(id,name),tags(id,label)",
      TASKS,
      QUERY_SCHEMA,
      QUERY_RELATIONSHIPS,
      3,
    );

    expect(selection).toMatchObject([
      { kind: "column", column: "id" },
      {
        kind: "relation",
        resource: "projects",
        alias: "project",
        hint: "project_id",
        selection: [
          { kind: "column", column: "id" },
          { kind: "column", column: "name" },
        ],
      },
      {
        kind: "relation",
        resource: "tags",
        selection: [
          { kind: "column", column: "id" },
          { kind: "column", column: "label" },
        ],
      },
    ]);
  });

  it("accepts normalized composite relationship hints", () => {
    expect(
      parseRestSelection(
        "composite_parents!parent_code, parent_region(code,region)",
        COMPOSITE_CHILDREN,
        QUERY_SCHEMA,
        QUERY_RELATIONSHIPS,
        2,
      ),
    ).toMatchObject([
      {
        kind: "relation",
        resource: "composite_parents",
        hint: "parent_code,parent_region",
      },
    ]);
  });

  it("rejects unknown columns and duplicate output names", () => {
    expect(expectCode("missing")).toBe("SLREST101");
    expect(expectCode("id,id")).toBe("SLREST103");
    expect(expectCode("id,ID")).toBe("SLREST103");
    expect(expectCode("same:id,same:title")).toBe("SLREST103");
    expect(expectCode("*,id")).toBe("SLREST103");
  });

  it("rejects malformed selection grammar", () => {
    for (const source of [
      "",
      ",id",
      "id,",
      " alias:id",
      "alias:",
      "x:*",
      "projects(id",
      "projects()",
      "projects!!x(id)",
      "(id)",
    ]) {
      expect(expectCode(source)).toBe("SLREST103");
    }
  });

  it("uses stable relationship errors", () => {
    expect(expectCode("missing(id)")).toBe("SLREST202");
    expect(expectCode("addresses(id)", ORDERS)).toBe("SLREST203");
    expect(expectCode("addresses!missing(id)", ORDERS)).toBe("SLREST202");
  });

  it("bounds recursive and adversarial relation nesting", () => {
    expect(expectCode("projects(tasks(id))", TASKS, 1)).toBe("SLREST110");
    expect(expectCode("projects(id)", TASKS, 0)).toBe("SLREST110");
    expect(
      expectCode(
        `${"projects(tasks(".repeat(1000)}id${"))".repeat(1000)}`,
        TASKS,
        5,
      ),
    ).toBe("SLREST110");
  });
});
