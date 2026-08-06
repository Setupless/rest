import { describe, expect, it } from "bun:test";
import {
  PROJECTS,
  QUERY_RELATIONSHIPS,
  QUERY_SCHEMA,
  TASKS,
} from "../../test/query-fixture";
import type { RestConfig } from "../config";
import { RestError } from "../http/errors";
import { MAX_QUERY_PARAMETERS, parseRestQuery, type RestQuery } from "./query";

const CONFIG: RestConfig = Object.freeze({
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 3000,
  maxRows: 100,
  maxEmbedDepth: 5,
  maxBodyBytes: 1024,
  busyTimeoutMs: 5000,
  corsOrigins: Object.freeze([]),
  logLevel: "info",
});

type TestHeadersInit = ConstructorParameters<typeof Headers>[0];

function parse(
  path: string,
  options: {
    readonly headers?: TestHeadersInit;
    readonly resource?: typeof TASKS;
    readonly config?: RestConfig;
  } = {},
): RestQuery {
  return parseRestQuery(
    new Request(`http://localhost${path}`, { headers: options.headers }),
    options.resource ?? TASKS,
    QUERY_SCHEMA,
    options.config ?? CONFIG,
    QUERY_RELATIONSHIPS,
  );
}

function expectCode(callback: () => unknown, code: RestError["code"]): void {
  try {
    callback();
    throw new Error("Expected parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).code).toBe(code);
  }
}

describe("parseRestQuery", () => {
  it("builds a schema-validated scalar plan with response controls", () => {
    const query = parse(
      "/tasks?select=task_id:ID,title&id=gte.1&order=priority.desc.nullslast&limit=200&offset=2",
      {
        headers: {
          Accept: "application/vnd.pgrst.object+json",
          Prefer: "count=exact",
        },
      },
    );

    expect(query).toEqual({
      selection: [
        { kind: "column", column: "id", alias: "task_id" },
        { kind: "column", column: "title" },
      ],
      filter: { field: "id", operator: "gte", value: 1 },
      order: [
        {
          field: "priority",
          direction: "desc",
          nulls: "last",
        },
      ],
      offset: 2,
      limit: 100,
      pagination: "query",
      countExact: true,
      singular: true,
    });
  });

  it("defaults to all scalar columns and configured bounds", () => {
    const query = parse("/tasks");
    expect(query.selection).toHaveLength(TASKS.columns.length);
    expect(query.order).toEqual([]);
    expect(query.offset).toBe(0);
    expect(query.limit).toBe(100);
    expect(query.pagination).toBe("query");
    expect(query.countExact).toBe(false);
    expect(query.singular).toBe(false);
  });

  it("builds independent recursively scoped embedded plans", () => {
    const query = parse(
      "/projects?select=id,children:tasks(id,title,tags(id,label))&children.priority=gte.2&children.order=priority.desc&children.limit=2&children.tags.order=label.asc&children.tags.offset=1&id=eq.10",
      { resource: PROJECTS },
    );

    expect(query.filter).toEqual({ field: "id", operator: "eq", value: 10 });
    const children = query.selection[1];
    expect(children).toMatchObject({
      kind: "relation",
      resource: "tasks",
      alias: "children",
      query: {
        filter: { field: "priority", operator: "gte", value: 2 },
        order: [{ field: "priority", direction: "desc" }],
        offset: 0,
        limit: 2,
        countExact: false,
        singular: false,
      },
    });
    if (children?.kind !== "relation") throw new Error("Missing relation");
    const tags = children.query.selection[2];
    expect(tags).toMatchObject({
      kind: "relation",
      resource: "tags",
      query: {
        order: [{ field: "label", direction: "asc" }],
        offset: 1,
        limit: 100,
      },
    });
  });

  it("retains explicit range pagination and applies precedence", () => {
    const query = parse("/tasks?limit=1&offset=9", {
      headers: { Range: "2-4", "Range-Unit": "items" },
    });
    expect(query).toMatchObject({
      offset: 2,
      limit: 3,
      pagination: "range",
    });
  });

  it("rejects strict range/query contradictions", () => {
    expectCode(
      () =>
        parse("/tasks?offset=1", {
          headers: { Range: "0-1", Prefer: "handling=strict" },
        }),
      "SLREST103",
    );
  });

  it("supports encoded identifiers containing punctuation", () => {
    const query = parse(
      "/tasks?select=odd%22name,odd.name&odd%22name=eq.value&order=odd.name.desc",
    );
    expect(query).toMatchObject({
      selection: [
        { kind: "column", column: 'odd"name' },
        { kind: "column", column: "odd.name" },
      ],
      filter: { field: 'odd"name', operator: "eq", value: "value" },
      order: [{ field: "odd.name", direction: "desc" }],
    });
  });

  it("rejects duplicate and unsupported nested controls", () => {
    expectCode(() => parse("/tasks?select=id&select=title"), "SLREST103");
    expectCode(() => parse("/tasks?order=id&order=title"), "SLREST103");
    expectCode(
      () =>
        parse("/projects?select=id,tasks(id)&tasks.select=title", {
          resource: PROJECTS,
        }),
      "SLREST103",
    );
    expectCode(
      () =>
        parse("/projects?select=id,tasks(id)&tasks.on_conflict=id", {
          resource: PROJECTS,
        }),
      "SLREST103",
    );
  });

  it("bounds aggregate query parameter work", () => {
    const parameters = new URLSearchParams();
    for (let index = 0; index <= MAX_QUERY_PARAMETERS; index += 1) {
      parameters.append("id", "eq.1");
    }
    expectCode(() => parse(`/tasks?${parameters}`), "SLREST103");
  });

  it("shares the configured bound with Boolean filter nesting", () => {
    expectCode(
      () =>
        parseRestQuery(
          new Request("http://localhost/tasks?id=eq.1&priority=eq.2"),
          TASKS,
          QUERY_SCHEMA,
          { ...CONFIG, maxEmbedDepth: 0 },
          QUERY_RELATIONSHIPS,
        ),
      "SLREST110",
    );
  });

  it("rejects malformed query percent encoding before parsing values", () => {
    expectCode(
      () =>
        parseRestQuery(
          new Request("http://localhost/tasks?select=%E0%A4%A"),
          TASKS,
          QUERY_SCHEMA,
          CONFIG,
          QUERY_RELATIONSHIPS,
        ),
      "SLREST100",
    );
  });

  it("deeply freezes the complete execution plan", () => {
    const query = parse(
      "/projects?select=id,tasks(id,tags(id))&tasks.id=gte.1",
      { resource: PROJECTS },
    );
    const tasks = query.selection[1];
    if (tasks?.kind !== "relation") throw new Error("Missing relation");
    const tags = tasks.query.selection[1];
    if (tags?.kind !== "relation") throw new Error("Missing relation");

    expect(
      [
        query,
        query.selection,
        ...query.selection,
        tasks.query,
        tasks.query.selection,
        tasks.query.filter,
        tags.query,
        tags.query.selection,
        ...tags.query.selection,
      ].every((value) => value === undefined || Object.isFrozen(value)),
    ).toBe(true);
  });
});
