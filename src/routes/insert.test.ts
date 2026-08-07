import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import { loadDatabaseSchema } from "../database/schema";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id INTEGER PRIMARY KEY);
  INSERT INTO projects VALUES (1);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL UNIQUE,
    priority INTEGER NOT NULL DEFAULT 7 CHECK (priority >= 0),
    normalized TEXT,
    generated TEXT GENERATED ALWAYS AS (title || '!') STORED
  );
  CREATE TRIGGER normalize_task AFTER INSERT ON tasks
  BEGIN
    UPDATE tasks SET normalized = upper(NEW.title) WHERE rowid = NEW.rowid;
  END;

  CREATE TABLE pairs (
    left_key TEXT,
    right_key TEXT,
    value TEXT,
    PRIMARY KEY (left_key, right_key)
  ) WITHOUT ROWID;

  CREATE TABLE rowid_records (value TEXT, normalized TEXT);
  CREATE TRIGGER normalize_rowid_record AFTER INSERT ON rowid_records
  BEGIN
    UPDATE rowid_records SET normalized = upper(NEW.value) WHERE rowid = NEW.rowid;
  END;

  CREATE TABLE unstable_records (value TEXT);
  CREATE TRIGGER remove_unstable_record AFTER INSERT ON unstable_records
  BEGIN
    DELETE FROM unstable_records WHERE rowid = NEW.rowid;
  END;

  CREATE VIEW task_view AS SELECT * FROM tasks;
  CREATE VIRTUAL TABLE searchable_tasks USING fts5(title);
`;

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`http://setupless.test${path}`, options);
}

function post(
  path: string,
  body: string,
  prefer?: string,
  extraHeaders: ConstructorParameters<typeof Headers>[0] = {},
): Request {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(prefer === undefined ? {} : { Prefer: prefer }),
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
    body,
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("transactional insert routes", () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(":memory:", { strict: true });
    database.run(SCHEMA);
  });

  afterEach(() => database.close());

  function app(auth?: RestAuthPlugin) {
    return createRestApp({
      database,
      schema: loadDatabaseSchema(database),
      auth,
    });
  }

  function taskCount(): number {
    return (
      database
        .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM tasks")
        .get()?.total ?? -1
    );
  }

  it("inserts one row with defaults and returns its trigger-aware post-image", async () => {
    const response = await app().handle(
      post(
        "/tasks?select=id:ID,title:TITLE,priority:PRIORITY,normalized:NORMALIZED,generated:GENERATED",
        '{"project_id":1,"title":"first"}',
        "missing=default, return=representation",
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Preference-Applied")).toBe(
      "return=representation, missing=default",
    );
    expect(await response.json()).toEqual([
      {
        id: 1,
        title: "first",
        priority: 7,
        normalized: "FIRST",
        generated: "first!",
      },
    ]);
  });

  it("inserts bulk rows atomically and preserves input order", async () => {
    const response = await app().handle(
      post(
        "/tasks?select=id,title",
        '[{"project_id":1,"title":"one"},{"project_id":1,"title":"two"}]',
        "missing=default, return=representation, count=exact",
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Range")).toBe("0-1/2");
    expect(response.headers.get("Range-Unit")).toBe("items");
    expect(await response.json()).toEqual([
      { id: 1, title: "one" },
      { id: 2, title: "two" },
    ]);
    expect(taskCount()).toBe(2);
  });

  it("rolls back every bulk row after uniqueness, foreign-key, and check failures", async () => {
    const duplicate = await app().handle(
      post(
        "/tasks",
        '[{"project_id":1,"title":"same"},{"project_id":1,"title":"same"}]',
        "missing=default",
      ),
    );
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("SLREST400");
    expect(taskCount()).toBe(0);

    const foreignKey = await app().handle(
      post(
        "/tasks",
        '{"project_id":99,"title":"missing parent"}',
        "missing=default",
      ),
    );
    expect(foreignKey.status).toBe(409);
    expect(await errorCode(foreignKey)).toBe("SLREST401");
    expect(taskCount()).toBe(0);

    const check = await app().handle(
      post(
        "/tasks",
        '{"project_id":1,"title":"invalid","priority":-1}',
        "missing=default",
      ),
    );
    expect(check.status).toBe(400);
    expect(await errorCode(check)).toBe("SLREST402");
    expect(taskCount()).toBe(0);
  });

  it("distinguishes missing=null from missing=default before applying defaults", async () => {
    const nullMissing = await app().handle(
      post("/tasks", '{"project_id":1,"title":"null default"}'),
    );
    expect(nullMissing.status).toBe(400);
    expect(await errorCode(nullMissing)).toBe("SLREST402");
    expect(taskCount()).toBe(0);

    const inconsistent = await app().handle(
      post(
        "/tasks",
        '[{"project_id":1,"title":"one"},{"project_id":1,"title":"two","priority":2}]',
        "missing=default",
      ),
    );
    expect(inconsistent.status).toBe(400);
    expect(await errorCode(inconsistent)).toBe("SLREST107");
    expect(taskCount()).toBe(0);
  });

  it("enforces authorization against AFTER-trigger post-images and rolls denial back", async () => {
    const authorized = app({
      authorize: () => ({
        allowed: true,
        check: { field: "normalized", operator: "eq", value: "ALLOWED" },
      }),
    });
    const allowed = await authorized.handle(
      post(
        "/tasks?select=title,normalized",
        '{"project_id":1,"title":"allowed"}',
        "missing=default, return=representation",
      ),
    );
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toEqual([
      { title: "allowed", normalized: "ALLOWED" },
    ]);

    const denied = await authorized.handle(
      post("/tasks", '{"project_id":1,"title":"denied"}', "missing=default"),
    );
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("SLREST405");
    expect(taskCount()).toBe(1);
  });

  it("supports rowid identities and rejects trigger-destroyed identities", async () => {
    const rowid = await app().handle(
      post(
        "/rowid_records?select=value,normalized",
        '{"value":"stable"}',
        "missing=default, return=representation",
      ),
    );
    expect(rowid.status).toBe(201);
    expect(await rowid.json()).toEqual([
      { value: "stable", normalized: "STABLE" },
    ]);

    const unstable = await app().handle(
      post("/unstable_records", '{"value":"gone"}', "missing=default"),
    );
    expect(unstable.status).toBe(409);
    expect(await errorCode(unstable)).toBe("SLREST406");
    expect(
      database
        .query<{ total: number }, []>(
          "SELECT COUNT(*) AS total FROM unstable_records",
        )
        .get()?.total,
    ).toBe(0);
  });

  it("preserves rowid identities outside the safe JavaScript integer range", async () => {
    const response = await app().handle(
      post(
        "/tasks?select=id,title",
        '{"id":"9007199254740992","project_id":1,"title":"exact"}',
        "missing=default, return=representation",
      ),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual([
      { id: "9007199254740992", title: "exact" },
    ]);
  });

  it("returns minimal, headers-only, singular, and exact-count modes", async () => {
    const minimal = await app().handle(
      post(
        "/tasks",
        '{"project_id":1,"title":"minimal"}',
        "missing=default, return=minimal, count=exact",
      ),
    );
    expect(minimal.status).toBe(201);
    expect(await minimal.text()).toBe("");
    expect(minimal.headers.get("Content-Type")).toBeNull();
    expect(minimal.headers.get("Content-Range")).toBe("0-0/1");

    const headersOnly = await app().handle(
      post(
        "/pairs",
        '{"left_key":"x &","right_key":"y/z!*","value":"linked"}',
        "missing=default, return=headers-only",
      ),
    );
    expect(headersOnly.status).toBe(201);
    expect(headersOnly.headers.get("Location")).toBe(
      "/pairs?left_key=eq.x%20%26&right_key=eq.y%2Fz%21%2A",
    );
    expect(await headersOnly.text()).toBe("");

    const singular = await app().handle(
      post(
        "/tasks?select=id,title",
        '{"project_id":1,"title":"singular"}',
        "missing=default, return=representation",
        { Accept: "application/vnd.pgrst.object+json" },
      ),
    );
    expect(singular.status).toBe(201);
    expect(await singular.json()).toEqual({ id: 2, title: "singular" });
  });

  it("rejects read-only resources, invalid columns, shapes, and media types before mutation", async () => {
    for (const resource of ["task_view", "searchable_tasks"]) {
      const response = await app().handle(
        post(`/${resource}`, '{"title":"blocked"}', "missing=default"),
      );
      expect(response.status).toBe(405);
      expect(await errorCode(response)).toBe("SLREST204");
      expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }

    for (const [body, code] of [
      ["null", "SLREST107"],
      ["[]", "SLREST107"],
      ['{"missing":1}', "SLREST101"],
      ['{"generated":"blocked"}', "SLREST206"],
      ['{"project_id":1,"title":9007199254740993}', "SLREST403"],
    ] as const) {
      const response = await app().handle(
        post("/tasks", body, "missing=default"),
      );
      expect(await errorCode(response)).toBe(code);
      expect(taskCount()).toBe(0);
    }

    const media = await app().handle(
      request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
    );
    expect(media.status).toBe(415);
    expect(await errorCode(media)).toBe("SLREST105");
    expect(taskCount()).toBe(0);

    for (const [rejectedRequest, code] of [
      [
        post(
          "/tasks?on_conflict=title",
          '{"project_id":1,"title":"conflict"}',
          "missing=default",
        ),
        "SLREST113",
      ],
      [
        post(
          "/tasks",
          '{"project_id":1,"title":"resolution"}',
          "missing=default, resolution=merge-duplicates",
        ),
        "SLREST113",
      ],
      [
        post(
          "/tasks?id=eq.1",
          '{"project_id":1,"title":"filtered"}',
          "missing=default",
        ),
        "SLREST103",
      ],
      [
        post("/tasks", '{"project_id":1,"title":"ranged"}', "missing=default", {
          Range: "0-0",
          "Range-Unit": "items",
        }),
        "SLREST103",
      ],
      [
        post(
          "/tasks",
          '[{"project_id":1,"title":"one"},{"project_id":1,"title":"two"}]',
          "missing=default",
          { Accept: "application/vnd.pgrst.object+json" },
        ),
        "SLREST106",
      ],
    ] as const) {
      const response = await app().handle(rejectedRequest);
      expect(await errorCode(response)).toBe(code);
      expect(taskCount()).toBe(0);
    }
  });
});
