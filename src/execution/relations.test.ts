import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import { type Database, openDatabase } from "../database/database";
import { type DatabaseSchema, loadDatabaseSchema } from "../database/schema";

const SCHEMA = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    region TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (id, region)
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER,
    project_region TEXT,
    parent_id INTEGER,
    title TEXT NOT NULL,
    priority INTEGER NOT NULL,
    FOREIGN KEY (project_id, project_region) REFERENCES projects(id, region),
    FOREIGN KEY (parent_id) REFERENCES tasks(id)
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL
  );
  CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    visible INTEGER NOT NULL,
    PRIMARY KEY (task_id, tag_id)
  );
  CREATE TABLE addresses (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    billing_address_id INTEGER REFERENCES addresses(id),
    shipping_address_id INTEGER REFERENCES addresses(id)
  );

  INSERT INTO projects VALUES
    (1, 'au', 'Alpha'),
    (2, 'us', 'Beta'),
    (3, 'nz', 'Empty');
  INSERT INTO tasks VALUES
    (1, 1, 'au', NULL, 'design', 2),
    (2, 1, 'au', 1, 'build', 3),
    (3, 1, 'au', 1, 'test', 1),
    (4, 2, 'us', NULL, 'ship', 1),
    (5, NULL, NULL, NULL, 'orphan', 9);
  INSERT INTO tags VALUES
    (10, 'backend'),
    (11, 'hidden-link'),
    (12, 'hidden-tag');
  INSERT INTO task_tags VALUES
    (1, 10, 1),
    (1, 11, 0),
    (1, 12, 1),
    (2, 10, 1);
  INSERT INTO addresses VALUES (1, 'billing'), (2, 'shipping');
  INSERT INTO orders VALUES (1, 1, 2);
`;

function request(target: string, options?: RequestInit): Request {
  return new Request(`http://setupless.test${target}`, options);
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("relation resource reads", () => {
  let database: Database;
  let schema: DatabaseSchema;

  beforeAll(() => {
    database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });
    database.run(SCHEMA);
    schema = loadDatabaseSchema(database);
  });

  afterAll(() => database.close());

  function app(
    options: {
      readonly auth?: RestAuthPlugin;
      readonly maxRows?: number;
      readonly maxEmbedDepth?: number;
    } = {},
  ) {
    return createRestApp({
      database,
      schema,
      auth: options.auth,
      maxRows: options.maxRows ?? 100,
      maxEmbedDepth: options.maxEmbedDepth ?? 5,
    });
  }

  it("embeds direct and inverse composite relations with left semantics", async () => {
    const direct = await app().handle(
      request("/tasks?select=id,project:projects(id,region,name)&order=id.asc"),
    );
    const inverse = await app().handle(
      request(
        "/projects?select=id,name,work:tasks(id,title)&order=id.asc&work.order=priority.desc",
      ),
    );

    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual([
      { id: 1, project: { id: 1, region: "au", name: "Alpha" } },
      { id: 2, project: { id: 1, region: "au", name: "Alpha" } },
      { id: 3, project: { id: 1, region: "au", name: "Alpha" } },
      { id: 4, project: { id: 2, region: "us", name: "Beta" } },
      { id: 5, project: null },
    ]);
    expect(await inverse.json()).toEqual([
      {
        id: 1,
        name: "Alpha",
        work: [
          { id: 2, title: "build" },
          { id: 1, title: "design" },
          { id: 3, title: "test" },
        ],
      },
      { id: 2, name: "Beta", work: [{ id: 4, title: "ship" }] },
      { id: 3, name: "Empty", work: [] },
    ]);
  });

  it("traverses many-to-many junctions and applies aliases and per-parent controls", async () => {
    const response = await app().handle(
      request(
        "/tasks?select=id,labels:tags(id,label)&order=id.asc&labels.order=id.desc&labels.offset=1&labels.limit=1",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 1, labels: [{ id: 11, label: "hidden-link" }] },
      { id: 2, labels: [] },
      { id: 3, labels: [] },
      { id: 4, labels: [] },
      { id: 5, labels: [] },
    ]);
  });

  it("applies embedded filters and the configured row cap per parent", async () => {
    const response = await app({ maxRows: 1 }).handle(
      request(
        "/projects?id=eq.1&select=id,work:tasks(id,title)&work.priority=gte.2&work.order=priority.desc",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 1, work: [{ id: 2, title: "build" }] },
    ]);
  });

  it("recurses through cyclic selections below the configured depth", async () => {
    const response = await app({ maxEmbedDepth: 3 }).handle(
      request(
        "/projects?id=eq.1&select=id,tasks(id,title,project:projects(id,name))&tasks.order=id.asc",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: 1,
        tasks: [
          { id: 1, title: "design", project: { id: 1, name: "Alpha" } },
          { id: 2, title: "build", project: { id: 1, name: "Alpha" } },
          { id: 3, title: "test", project: { id: 1, name: "Alpha" } },
        ],
      },
    ]);
  });

  it("enforces target and junction authorization without weakening root visibility", async () => {
    const calls: string[] = [];
    const auth: RestAuthPlugin = {
      authorize: ({ table }) => {
        calls.push(table);
        if (table === "tags") {
          return {
            allowed: true,
            using: { field: "id", operator: "neq", value: 12 },
          };
        }
        if (table === "task_tags") {
          return {
            allowed: true,
            using: { field: "visible", operator: "eq", value: 1 },
          };
        }
        return { allowed: true };
      },
    };
    const response = await app({ auth }).handle(
      request("/tasks?id=eq.1&select=id,tags(id,label)"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 1, tags: [{ id: 10, label: "backend" }] },
    ]);
    expect(calls).toEqual(["tasks", "tags", "task_tags"]);
  });

  it("fails the request when an embedded resource is denied, even for no root rows", async () => {
    const response = await app({
      auth: {
        authorize: ({ table }) =>
          table === "tags"
            ? { allowed: false, status: 403 }
            : { allowed: true },
      },
    }).handle(request("/tasks?id=eq.999&select=id,tags(id)"));

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("SLREST303");
  });

  it("uses stable relationship errors and FK-column hints", async () => {
    const ambiguous = await app().handle(
      request("/orders?select=id,addresses(id,label)"),
    );
    const hinted = await app().handle(
      request(
        "/orders?select=id,billing:addresses!billing_address_id(id,label),shipping:addresses!shipping_address_id(id,label)",
      ),
    );
    const missing = await app().handle(request("/projects?select=id,tags(id)"));

    expect(ambiguous.status).toBe(300);
    expect(await errorCode(ambiguous)).toBe("SLREST203");
    expect(await hinted.json()).toEqual([
      {
        id: 1,
        billing: { id: 1, label: "billing" },
        shipping: { id: 2, label: "shipping" },
      },
    ]);
    expect(await errorCode(missing)).toBe("SLREST202");
  });

  it("batches parent keys within the SQLite variable budget", async () => {
    database.run("SAVEPOINT relation_batch_test");
    try {
      const insertProjects = database.transaction((count: number) => {
        const insert = database.query(
          "INSERT INTO projects (id, region, name) VALUES (?, 'batch', ?)",
        );
        const insertTask = database.query(
          "INSERT INTO tasks (id, project_id, project_region, title, priority) VALUES (?, ?, 'batch', 'batched', 1)",
        );
        for (let index = 0; index < count; index += 1) {
          const projectId = 10_000 + index;
          insert.run(projectId, `project-${index}`);
          insertTask.run(20_000 + index, projectId);
        }
      });
      insertProjects(1_005);

      const response = await app({ maxRows: 1_100 }).handle(
        request(
          "/projects?region=eq.batch&select=id,tasks(id)&order=id.asc&limit=1100",
        ),
      );
      const rows = (await response.json()) as {
        id: number;
        tasks: { id: number }[];
      }[];

      expect(response.status).toBe(200);
      expect(rows).toHaveLength(1_005);
      expect(rows[0]).toEqual({ id: 10_000, tasks: [{ id: 20_000 }] });
      expect(rows.at(-1)).toEqual({
        id: 11_004,
        tasks: [{ id: 21_004 }],
      });
    } finally {
      database.run("ROLLBACK TO relation_batch_test");
      database.run("RELEASE relation_batch_test");
    }
  });
});
