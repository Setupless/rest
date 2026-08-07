import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import { openDatabase } from "../database/database";
import { loadDatabaseSchema } from "../database/schema";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id INTEGER PRIMARY KEY);
  INSERT INTO projects VALUES (1), (2);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    tenant_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL UNIQUE,
    priority INTEGER NOT NULL CHECK (priority >= 0),
    done BOOLEAN NOT NULL DEFAULT 0,
    normalized TEXT,
    generated TEXT GENERATED ALWAYS AS (title || '!') STORED,
    UNIQUE (tenant_id, code)
  );
  CREATE TRIGGER normalize_task AFTER UPDATE OF title ON tasks
  BEGIN
    UPDATE tasks SET normalized = upper(NEW.title) WHERE rowid = NEW.rowid;
  END;

  INSERT INTO tasks
    (id, project_id, tenant_id, code, title, priority, done, normalized)
  VALUES
    (1, 1, 1, 'a', 'one', 1, 0, 'ONE'),
    (2, 1, 1, 'b', 'two', 2, 0, 'TWO'),
    (3, 1, 2, 'a', 'three', 3, 0, 'THREE'),
    (4, 2, 2, 'b', 'four', 4, 1, 'FOUR');

  CREATE TABLE children (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id)
  );
  INSERT INTO children VALUES (1, 1);

  CREATE TABLE pairs (
    left_key TEXT,
    right_key TEXT,
    value TEXT,
    PRIMARY KEY (left_key, right_key)
  ) WITHOUT ROWID;
  INSERT INTO pairs VALUES ('a', '1', 'first'), ('a', '2', 'second');

  CREATE VIEW task_view AS SELECT * FROM tasks;
  CREATE VIRTUAL TABLE searchable_tasks USING fts5(title);
`;

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`http://setupless.test${path}`, options);
}

function patch(
  path: string,
  body: string,
  prefer?: string,
  extraHeaders: ConstructorParameters<typeof Headers>[0] = {},
): Request {
  return request(path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(prefer === undefined ? {} : { Prefer: prefer }),
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
    body,
  });
}

function remove(
  path: string,
  prefer?: string,
  extraHeaders: ConstructorParameters<typeof Headers>[0] = {},
): Request {
  return request(path, {
    method: "DELETE",
    headers: {
      ...(prefer === undefined ? {} : { Prefer: prefer }),
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("filtered update and delete routes", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });
    database.run(SCHEMA);
  });

  afterEach(() => database.close());

  function app(options: { auth?: RestAuthPlugin; maxRows?: number } = {}) {
    return createRestApp({
      database,
      schema: loadDatabaseSchema(database),
      auth: options.auth,
      maxRows: options.maxRows ?? 1000,
    });
  }

  function tasks(): Array<{
    id: number;
    priority: number;
    done: number;
    title: string;
    normalized: string;
  }> {
    return database
      .query<
        {
          id: number;
          priority: number;
          done: number;
          title: string;
          normalized: string;
        },
        []
      >("SELECT id, priority, done, title, normalized FROM tasks ORDER BY id")
      .all();
  }

  it("updates filtered and full-table targets without applying the read row cap", async () => {
    const filtered = await app({ maxRows: 1 }).handle(
      patch(
        "/tasks?or=(id.eq.1,id.eq.3)&order=id.asc&select=id,done",
        '{"done":true}',
        "return=representation, count=exact",
      ),
    );
    expect(filtered.status).toBe(200);
    expect(filtered.headers.get("Content-Range")).toBe("0-1/2");
    expect(await filtered.json()).toEqual([
      { id: 1, done: true },
      { id: 3, done: true },
    ]);

    const fullTable = await app({ maxRows: 1 }).handle(
      patch("/tasks", '{"priority":9}', "max-affected=4, return=minimal"),
    );
    expect(fullTable.status).toBe(204);
    expect(fullTable.headers.get("Preference-Applied")).toBe(
      "return=minimal, max-affected=4",
    );
    expect(tasks().map((task) => task.priority)).toEqual([9, 9, 9, 9]);
  });

  it("ANDs client filters with authorization using and rolls back denied post-images", async () => {
    const authorized = app({
      auth: {
        authorize: ({ operation }) => ({
          allowed: true,
          using: { field: "tenant_id", operator: "eq", value: 1 },
          ...(operation === "update"
            ? {
                check: {
                  field: "priority",
                  operator: "lte",
                  value: 5,
                } as const,
              }
            : {}),
        }),
      },
    });
    const narrowed = await authorized.handle(
      patch(
        "/tasks?or=(tenant_id.eq.2,id.eq.1)&select=id,priority",
        '{"priority":5}',
        "return=representation",
      ),
    );
    expect(await narrowed.json()).toEqual([{ id: 1, priority: 5 }]);

    const denied = await authorized.handle(
      patch("/tasks", '{"priority":8}', "return=minimal"),
    );
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("SLREST405");
    expect(tasks().map((task) => task.priority)).toEqual([5, 2, 3, 4]);
  });

  it("requires complete unique ordering for query and Range bounded mutations", async () => {
    const invalid = await app().handle(
      patch("/tasks?order=tenant_id.asc&limit=1", '{"priority":8}'),
    );
    expect(await errorCode(invalid)).toBe("SLREST207");
    expect(tasks().map((task) => task.priority)).toEqual([1, 2, 3, 4]);

    const page = await app().handle(
      patch(
        "/tasks?order=id.desc&limit=2&offset=1&select=id,priority",
        '{"priority":7}',
        "return=representation",
      ),
    );
    expect(await page.json()).toEqual([
      { id: 3, priority: 7 },
      { id: 2, priority: 7 },
    ]);

    const range = await app().handle(
      patch(
        "/tasks?order=tenant_id.asc,code.asc&select=id,done",
        '{"done":true}',
        "return=representation",
        { Range: "1-1", "Range-Unit": "items" },
      ),
    );
    expect(await range.json()).toEqual([{ id: 2, done: true }]);
  });

  it("checks actual max-affected and rolls every update back when exceeded", async () => {
    const response = await app().handle(
      patch(
        "/tasks?done=is.false&order=id.asc",
        '{"priority":6}',
        "max-affected=2, return=representation",
      ),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("SLREST111");
    expect(tasks().map((task) => task.priority)).toEqual([1, 2, 3, 4]);

    const deletion = await app().handle(
      remove(
        "/tasks?id=gte.2&order=id.asc",
        "max-affected=1, return=representation",
      ),
    );
    expect(await errorCode(deletion)).toBe("SLREST111");
    expect(tasks().map((task) => task.id)).toEqual([1, 2, 3, 4]);
  });

  it("returns trigger-aware update post-images and pre-image delete representations", async () => {
    const updated = await app().handle(
      patch(
        "/tasks?id=eq.2&select=id,title,normalized,generated",
        '{"title":"changed"}',
        "return=representation",
      ),
    );
    expect(await updated.json()).toEqual([
      {
        id: 2,
        title: "changed",
        normalized: "CHANGED",
        generated: "changed!",
      },
    ]);

    const deleted = await app().handle(
      remove(
        "/tasks?id=in.(3,4)&order=id.desc&select=id,title",
        "return=representation, count=exact",
      ),
    );
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("Content-Range")).toBe("0-1/2");
    expect(await deleted.json()).toEqual([
      { id: 4, title: "four" },
      { id: 3, title: "three" },
    ]);
  });

  it("supports full-table DELETE, policy filtering, and successful zero-row outcomes", async () => {
    const authorized = app({
      auth: {
        authorize: () => ({
          allowed: true,
          using: { field: "tenant_id", operator: "eq", value: 2 },
          check: { field: "id", operator: "eq", value: 999 },
        }),
      },
    });
    const fullTable = await authorized.handle(
      remove("/tasks", "return=minimal, count=exact"),
    );
    expect(fullTable.status).toBe(204);
    expect(fullTable.headers.get("Content-Range")).toBe("0-1/2");
    expect(tasks().map((task) => task.id)).toEqual([1, 2]);

    const zero = await authorized.handle(
      remove("/tasks?id=eq.99", "return=representation, count=exact"),
    );
    expect(zero.status).toBe(200);
    expect(zero.headers.get("Content-Range")).toBe("*/0");
    expect(await zero.json()).toEqual([]);
  });

  it("mutates WITHOUT ROWID tables through composite primary-key identities", async () => {
    const updated = await app().handle(
      patch(
        "/pairs?left_key=eq.a&order=left_key.asc,right_key.desc&limit=1&select=left_key,right_key,value",
        '{"value":"updated"}',
        "return=representation",
      ),
    );
    expect(await updated.json()).toEqual([
      { left_key: "a", right_key: "2", value: "updated" },
    ]);

    const deleted = await app().handle(
      remove(
        "/pairs?right_key=eq.1&select=left_key,right_key,value",
        "return=representation",
      ),
    );
    expect(await deleted.json()).toEqual([
      { left_key: "a", right_key: "1", value: "first" },
    ]);
  });

  it("rejects invalid PATCH payloads and read-only mutation targets before SQL", async () => {
    for (const [body, code] of [
      ["null", "SLREST107"],
      ["[]", "SLREST107"],
      ["{}", "SLREST107"],
      ['{"missing":1}', "SLREST101"],
      ['{"generated":"blocked"}', "SLREST206"],
      ['{"priority":1.5}', "SLREST403"],
    ] as const) {
      const response = await app().handle(patch("/tasks", body));
      expect(await errorCode(response)).toBe(code);
      expect(tasks()).toHaveLength(4);
    }

    for (const resource of ["task_view", "searchable_tasks"]) {
      const update = await app().handle(patch(`/${resource}`, '{"title":"x"}'));
      const deletion = await app().handle(remove(`/${resource}`));
      expect(await errorCode(update)).toBe("SLREST204");
      expect(await errorCode(deletion)).toBe("SLREST204");
      expect(update.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }
  });

  it("rolls back constraint failures after earlier rows were changed or deleted", async () => {
    const unique = await app().handle(
      patch("/tasks?id=in.(1,2)&order=id.asc", '{"title":"duplicate"}'),
    );
    expect(await errorCode(unique)).toBe("SLREST400");
    expect(tasks().map((task) => task.title)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);

    const foreignKey = await app().handle(
      patch("/tasks?id=eq.2", '{"project_id":99}'),
    );
    expect(await errorCode(foreignKey)).toBe("SLREST401");

    const deletion = await app().handle(
      remove("/tasks?id=in.(1,2)&order=id.desc", "return=representation"),
    );
    expect(await errorCode(deletion)).toBe("SLREST401");
    expect(tasks().map((task) => task.id)).toEqual([1, 2, 3, 4]);
  });

  it("enforces singular mutation media and all response modes", async () => {
    const singular = await app().handle(
      patch(
        "/tasks?id=eq.1&select=id,priority",
        '{"priority":5}',
        "return=representation",
        { Accept: "application/vnd.pgrst.object+json" },
      ),
    );
    expect(await singular.json()).toEqual({ id: 1, priority: 5 });

    const many = await app().handle(
      patch("/tasks?tenant_id=eq.2", '{"priority":8}', "return=minimal", {
        Accept: "application/vnd.pgrst.object+json",
      }),
    );
    expect(await errorCode(many)).toBe("SLREST106");
    expect(
      tasks()
        .slice(2)
        .map((task) => task.priority),
    ).toEqual([3, 4]);

    const headersOnly = await app().handle(
      remove("/tasks?id=eq.3", "return=headers-only, count=exact"),
    );
    expect(headersOnly.status).toBe(204);
    expect(await headersOnly.text()).toBe("");
    expect(headersOnly.headers.get("Content-Range")).toBe("0-0/1");
    expect(headersOnly.headers.get("Location")).toBeNull();
  });

  it("maps a real SQLite write lock to a retryable response without mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "setupless-mutation-lock-"));
    const path = join(directory, "locked.sqlite");
    const primary = openDatabase({ path, busyTimeoutMs: 0 });
    let blocker: Database | undefined;
    try {
      primary.run(
        "CREATE TABLE locked_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      );
      primary.run("INSERT INTO locked_rows VALUES (1, 'unchanged')");
      const lockedApp = createRestApp({
        database: primary,
        schema: loadDatabaseSchema(primary),
      });
      blocker = openDatabase({ path, busyTimeoutMs: 0 });
      blocker.run("BEGIN IMMEDIATE");

      const response = await lockedApp.handle(
        patch("/locked_rows?id=eq.1", '{"value":"changed"}'),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await errorCode(response)).toBe("SLREST502");
      expect(
        primary
          .query<{ value: string }, []>(
            "SELECT value FROM locked_rows WHERE id = 1",
          )
          .get()?.value,
      ).toBe("unchanged");
    } finally {
      if (blocker !== undefined) {
        try {
          blocker.run("ROLLBACK");
        } catch {
          // The assertion path may fail before the lock is acquired.
        }
        blocker.close();
      }
      primary.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
