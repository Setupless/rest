import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import { openDatabase } from "../database/database";
import { loadDatabaseSchema } from "../database/schema";

const SCHEMA = `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 7 CHECK (priority >= 0),
    note TEXT DEFAULT 'default-note',
    normalized TEXT,
    generated TEXT GENERATED ALWAYS AS (title || '!') STORED,
    UNIQUE (tenant_id, code)
  );
  CREATE UNIQUE INDEX item_partial_note ON items(note) WHERE priority > 10;
  CREATE UNIQUE INDEX item_expression_title ON items(lower(title));
  CREATE TRIGGER normalize_item_insert AFTER INSERT ON items
  BEGIN
    UPDATE items SET normalized = upper(NEW.title) WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER normalize_item_update AFTER UPDATE OF title ON items
  BEGIN
    UPDATE items SET normalized = upper(NEW.title) WHERE rowid = NEW.rowid;
  END;
  INSERT INTO items
    (id, tenant_id, code, title, priority, note, normalized)
  VALUES
    (1, 1, 'a', 'one', 1, 'keep', 'ONE'),
    (9, 2, 'z', 'nine', 2, 'other', 'NINE');

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  INSERT INTO settings VALUES ('theme', 'light');

  CREATE TABLE pairs (
    left_key TEXT,
    right_key TEXT,
    value TEXT NOT NULL,
    flag INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (left_key, right_key)
  ) WITHOUT ROWID;
  INSERT INTO pairs VALUES ('a', '1', 'first', 0);

  CREATE TABLE heap (value TEXT);
  CREATE TABLE defaulted (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL DEFAULT 'shared' UNIQUE,
    value TEXT NOT NULL
  );
  INSERT INTO defaulted (value) VALUES ('initial');
  CREATE TABLE expression_defaulted (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL DEFAULT (lower('SHARED')) UNIQUE,
    value TEXT NOT NULL
  );
  INSERT INTO expression_defaulted (value) VALUES ('initial');
  CREATE TABLE aliases (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE (handle COLLATE NOCASE)
  );
  INSERT INTO aliases VALUES (1, 'MixedCase', 'initial');
  CREATE VIEW item_view AS SELECT * FROM items;
`;

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`http://setupless.test${path}`, options);
}

function write(
  method: "POST" | "PUT",
  path: string,
  body: string,
  prefer?: string,
  extraHeaders: ConstructorParameters<typeof Headers>[0] = {},
): Request {
  return request(path, {
    method,
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

describe("POST conflict resolution and single-row PUT", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });
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

  function items(): Array<{
    id: number;
    tenant_id: number;
    code: string;
    title: string;
    priority: number;
    note: string | null;
    normalized: string;
  }> {
    return database
      .query<
        {
          id: number;
          tenant_id: number;
          code: string;
          title: string;
          priority: number;
          note: string | null;
          normalized: string;
        },
        []
      >(
        "SELECT id, tenant_id, code, title, priority, note, normalized FROM items ORDER BY id",
      )
      .all();
  }

  it("merges by primary key and returns a trigger-aware post-image", async () => {
    const response = await app().handle(
      write(
        "POST",
        "/items?select=id,title,priority,note,normalized,generated",
        '{"id":1,"tenant_id":1,"code":"a","title":"changed"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Preference-Applied")).toBe(
      "return=representation, missing=default, resolution=merge-duplicates",
    );
    expect(await response.json()).toEqual([
      {
        id: 1,
        title: "changed",
        priority: 1,
        note: "keep",
        normalized: "CHANGED",
        generated: "changed!",
      },
    ]);
  });

  it("normalizes alternate and composite conflict targets to schema order", async () => {
    const alternate = await app().handle(
      write(
        "POST",
        "/items?on_conflict=code,tenant_id&select=id,title,priority",
        '{"tenant_id":1,"code":"a","title":"alternate"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await alternate.json()).toEqual([
      { id: 1, title: "alternate", priority: 1 },
    ]);

    const composite = await app().handle(
      write(
        "POST",
        "/pairs?on_conflict=right_key,left_key&select=left_key,right_key,value,flag",
        '{"left_key":"a","right_key":"1","value":"changed"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await composite.json()).toEqual([
      { left_key: "a", right_key: "1", value: "changed", flag: 0 },
    ]);

    const collated = await app().handle(
      write(
        "POST",
        "/aliases?on_conflict=handle&select=id,handle,value",
        '{"handle":"mixedcase","value":"collated"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await collated.json()).toEqual([
      { id: 1, handle: "mixedcase", value: "collated" },
    ]);
  });

  it("distinguishes ignored duplicates from affected rows", async () => {
    const ignored = await app().handle(
      write(
        "POST",
        "/items?select=id,title",
        '{"id":1,"tenant_id":1,"code":"a","title":"ignored"}',
        "missing=default, resolution=ignore-duplicates, return=representation, count=exact",
      ),
    );

    expect(ignored.status).toBe(201);
    expect(ignored.headers.get("Content-Range")).toBe("*/0");
    expect(await ignored.json()).toEqual([]);
    expect(items()[0]?.title).toBe("one");
  });

  it("pins singular ignore and headers-only upsert responses", async () => {
    const singularIgnore = await app().handle(
      write(
        "POST",
        "/items",
        '{"id":1,"tenant_id":1,"code":"a","title":"ignored"}',
        "missing=default, resolution=ignore-duplicates, return=representation",
        { Accept: "application/vnd.pgrst.object+json" },
      ),
    );
    expect(singularIgnore.status).toBe(406);
    expect(await errorCode(singularIgnore)).toBe("SLREST106");

    const headersOnly = await app().handle(
      write(
        "POST",
        "/items",
        '{"id":1,"tenant_id":1,"code":"a","title":"headers"}',
        "missing=default, resolution=merge-duplicates, return=headers-only",
      ),
    );
    expect(headersOnly.status).toBe(201);
    expect(headersOnly.headers.get("Location")).toBe("/items?id=eq.1");
    expect(await headersOnly.text()).toBe("");
  });

  it("applies missing defaults and preserves bulk input order atomically", async () => {
    const response = await app().handle(
      write(
        "POST",
        "/items?select=id,title,priority,note",
        '[{"id":1,"tenant_id":1,"code":"a","title":"merged"},{"id":2,"tenant_id":1,"code":"b","title":"inserted"}]',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );

    expect(await response.json()).toEqual([
      { id: 1, title: "merged", priority: 1, note: "keep" },
      { id: 2, title: "inserted", priority: 7, note: "default-note" },
    ]);

    const defaultTarget = await app().handle(
      write(
        "POST",
        "/defaulted?on_conflict=slug&select=id,slug,value",
        '{"value":"merged default"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await defaultTarget.json()).toEqual([
      { id: 1, slug: "shared", value: "merged default" },
    ]);

    const expressionTarget = await app().handle(
      write(
        "POST",
        "/expression_defaulted?on_conflict=slug&select=id,slug,value",
        '{"value":"merged expression"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await expressionTarget.json()).toEqual([
      { id: 1, slug: "shared", value: "merged expression" },
    ]);
  });

  it("rolls back mixed bulk work after constraints and policy checks", async () => {
    const constraint = await app().handle(
      write(
        "POST",
        "/items",
        '[{"id":1,"tenant_id":1,"code":"a","title":"changed","priority":4},{"id":2,"tenant_id":1,"code":"b","title":"bad","priority":-1}]',
        "missing=default, resolution=merge-duplicates",
      ),
    );
    expect(await errorCode(constraint)).toBe("SLREST402");
    expect(items().map((item) => item.title)).toEqual(["one", "nine"]);

    const authorized = app({
      authorize: ({ operation }) => ({
        allowed: true,
        ...(operation === "insert" || operation === "update"
          ? {
              check: {
                field: "priority",
                operator: "lte",
                value: 5,
              } as const,
            }
          : {}),
      }),
    });
    const policy = await authorized.handle(
      write(
        "POST",
        "/items",
        '[{"id":1,"tenant_id":1,"code":"a","title":"allowed","priority":4},{"id":2,"tenant_id":1,"code":"b","title":"denied","priority":9}]',
        "missing=default, resolution=merge-duplicates",
      ),
    );
    expect(await errorCode(policy)).toBe("SLREST405");
    expect(items().map((item) => item.title)).toEqual(["one", "nine"]);
  });

  it("enforces update using and only requires the phase a row takes", async () => {
    const filtered = app({
      authorize: ({ operation }) => ({
        allowed: true,
        ...(operation === "update"
          ? {
              using: {
                field: "tenant_id",
                operator: "eq",
                value: 1,
              } as const,
            }
          : {}),
      }),
    });
    const denied = await filtered.handle(
      write(
        "POST",
        "/items",
        '{"id":9,"tenant_id":2,"code":"z","title":"blocked"}',
        "missing=default, resolution=merge-duplicates",
      ),
    );
    expect(await errorCode(denied)).toBe("SLREST303");
    expect(items()[1]?.title).toBe("nine");

    const insertDenied = app({
      authorize: ({ operation }) =>
        operation === "insert" ? { allowed: false } : { allowed: true },
    });
    const merged = await insertDenied.handle(
      write(
        "POST",
        "/items?select=id,title",
        '{"id":1,"tenant_id":1,"code":"a","title":"update-only"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(merged.status).toBe(201);
    expect(await merged.json()).toEqual([{ id: 1, title: "update-only" }]);

    const updateDenied = app({
      authorize: ({ operation }) =>
        operation === "update" ? { allowed: false } : { allowed: true },
    });
    const inserted = await updateDenied.handle(
      write(
        "POST",
        "/items?select=id,title",
        '{"id":2,"tenant_id":1,"code":"b","title":"insert-only"}',
        "missing=default, resolution=merge-duplicates, return=representation",
      ),
    );
    expect(inserted.status).toBe(201);
    expect(await inserted.json()).toEqual([{ id: 2, title: "insert-only" }]);
  });

  it("supports natural primary keys and rejects invalid targets before SQL", async () => {
    const natural = await app().handle(
      write(
        "POST",
        "/settings?select=key,value",
        '{"key":"theme","value":"dark"}',
        "resolution=merge-duplicates, return=representation",
      ),
    );
    expect(await natural.json()).toEqual([{ key: "theme", value: "dark" }]);

    for (const [path, code] of [
      ["/items?on_conflict=note", "SLREST113"],
      ["/items?on_conflict=title", "SLREST113"],
      ["/items?on_conflict=tenant_id", "SLREST113"],
      ["/items?on_conflict=id,id", "SLREST113"],
      ["/items?on_conflict=missing", "SLREST101"],
      ["/items?on_conflict=id&on_conflict=id", "SLREST113"],
      ["/heap", "SLREST113"],
    ] as const) {
      const response = await app().handle(
        write(
          "POST",
          path,
          path === "/heap"
            ? '{"value":"x"}'
            : '{"id":3,"tenant_id":3,"code":"c","title":"candidate"}',
          "missing=default, resolution=merge-duplicates",
        ),
      );
      expect(await errorCode(response)).toBe(code);
    }
    expect(items().map((item) => item.id)).toEqual([1, 9]);

    const withoutResolution = await app().handle(
      write(
        "POST",
        "/items?on_conflict=id",
        '{"id":3,"tenant_id":3,"code":"c","title":"candidate"}',
        "missing=default",
      ),
    );
    expect(await errorCode(withoutResolution)).toBe("SLREST113");
  });

  it("inserts and updates PUT rows with all return modes", async () => {
    const inserted = await app().handle(
      write(
        "PUT",
        "/items?id=eq.2&select=id,title,priority,note,normalized",
        '{"id":2,"tenant_id":1,"code":"b","title":"put insert"}',
        "missing=default, return=representation, count=exact",
      ),
    );
    expect(inserted.status).toBe(201);
    expect(inserted.headers.get("Location")).toBe("/items?id=eq.2");
    expect(inserted.headers.get("Content-Range")).toBe("0-0/1");
    expect(await inserted.json()).toEqual([
      {
        id: 2,
        title: "put insert",
        priority: 7,
        note: "default-note",
        normalized: "PUT INSERT",
      },
    ]);

    const updated = await app().handle(
      write(
        "PUT",
        "/items?id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"put update"}',
        "missing=default, return=minimal",
      ),
    );
    expect(updated.status).toBe(201);
    expect(updated.headers.get("Location")).toBe("/items?id=eq.1");
    expect(await updated.text()).toBe("");
    expect(items()[0]).toMatchObject({
      title: "put update",
      priority: 1,
      note: "keep",
      normalized: "PUT UPDATE",
    });

    const headersOnly = await app().handle(
      write(
        "PUT",
        "/settings?key=eq.theme",
        '{"key":"theme","value":"contrast"}',
        "return=headers-only",
      ),
    );
    expect(headersOnly.status).toBe(201);
    expect(headersOnly.headers.get("Location")).toBe("/settings?key=eq.theme");
  });

  it("supports composite PUT identities", async () => {
    const response = await app().handle(
      write(
        "PUT",
        "/pairs?right_key=eq.2&left_key=eq.a&select=left_key,right_key,value,flag",
        '{"left_key":"a","right_key":"2","value":"second"}',
        "missing=default, return=representation",
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe(
      "/pairs?left_key=eq.a&right_key=eq.2",
    );
    expect(await response.json()).toEqual([
      { left_key: "a", right_key: "2", value: "second", flag: 0 },
    ]);
  });

  it("rejects invalid PUT identities, controls, and payloads before mutation", async () => {
    const cases = [
      [
        "/items",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?id=gte.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?tenant_id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?id=eq.1&id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?id=eq.1&order=id.asc",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?id=eq.1&limit=1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      [
        "/items?id=eq.1",
        '{"id":2,"tenant_id":1,"code":"a","title":"x"}',
        {},
        "SLREST112",
      ],
      ["/items?id=eq.1", '{"id":1,"tenant_id":1,"title":"x"}', {}, "SLREST112"],
      [
        "/items?id=eq.1",
        '[{"id":1,"tenant_id":1,"code":"a","title":"x"}]',
        {},
        "SLREST107",
      ],
      [
        "/items?id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
        { Range: "0-0" },
        "SLREST112",
      ],
      ["/heap?value=eq.x", '{"value":"x"}', {}, "SLREST112"],
    ] as const;

    for (const [path, body, headers, code] of cases) {
      const response = await app().handle(
        write("PUT", path, body, "missing=default", headers),
      );
      expect(await errorCode(response)).toBe(code);
    }
    expect(items().map((item) => item.title)).toEqual(["one", "nine"]);

    const nullMissing = await app().handle(
      write(
        "PUT",
        "/items?id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"null default"}',
      ),
    );
    expect(await errorCode(nullMissing)).toBe("SLREST402");
    expect(items()[0]?.title).toBe("one");

    const view = await app().handle(
      write(
        "PUT",
        "/item_view?id=eq.1",
        '{"id":1,"tenant_id":1,"code":"a","title":"x"}',
      ),
    );
    expect(view.status).toBe(405);
    expect(view.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("applies insert and update authorization independently for PUT", async () => {
    const authorized = app({
      authorize: ({ operation }) => ({
        allowed: true,
        ...(operation === "update"
          ? {
              using: {
                field: "tenant_id",
                operator: "eq",
                value: 1,
              } as const,
            }
          : operation === "insert"
            ? {
                check: {
                  field: "priority",
                  operator: "lte",
                  value: 5,
                } as const,
              }
            : {}),
      }),
    });

    const deniedUpdate = await authorized.handle(
      write(
        "PUT",
        "/items?id=eq.9",
        '{"id":9,"tenant_id":2,"code":"z","title":"blocked"}',
        "missing=default",
      ),
    );
    expect(await errorCode(deniedUpdate)).toBe("SLREST303");

    const deniedInsert = await authorized.handle(
      write(
        "PUT",
        "/items?id=eq.2",
        '{"id":2,"tenant_id":1,"code":"b","title":"blocked"}',
        "missing=default",
      ),
    );
    expect(await errorCode(deniedInsert)).toBe("SLREST405");
    expect(items().map((item) => item.id)).toEqual([1, 9]);
  });
});
