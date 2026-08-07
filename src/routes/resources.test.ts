import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createRestApp } from "../app";
import type { RestAuthPlugin } from "../auth/types";
import { type Database, openDatabase } from "../database/database";
import { type DatabaseSchema, loadDatabaseSchema } from "../database/schema";

const SCHEMA = `
  CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    unsafe_integer INTEGER,
    ratio REAL,
    enabled BOOLEAN,
    payload JSON,
    bytes BLOB,
    note TEXT
  );
  CREATE VIEW record_view AS SELECT * FROM records;
  CREATE TABLE related (
    id INTEGER PRIMARY KEY,
    record_id INTEGER REFERENCES records(id)
  );
  CREATE TABLE "odd""table" (
    "odd""column" TEXT
  );

  INSERT INTO records VALUES
    (1, 1, 9007199254740991, 1.25, 1, '{"ok":true,"n":0.1}', X'00A5FF', 'first'),
    (2, 1, 9007199254740992, 2.5, 0, NULL, NULL, 'second'),
    (3, 2, 9223372036854775807, 3.75, 1, '[1,null]', X'DEADBEEF', 'third');
  INSERT INTO related VALUES (1, 1);
  INSERT INTO "odd""table" VALUES ('quoted');
`;

function request(target: string, options?: RequestInit): Request {
  return new Request(`http://setupless.test${target}`, options);
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("scalar resource routes", () => {
  let database: Database;
  let schema: DatabaseSchema;

  beforeAll(() => {
    database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });
    database.run(SCHEMA);
    schema = loadDatabaseSchema(database);
  });

  afterAll(() => database.close());

  function app(options: { auth?: RestAuthPlugin; maxRows?: number } = {}) {
    return createRestApp({
      database,
      schema,
      auth: options.auth,
      maxRows: options.maxRows ?? 1000,
    });
  }

  it("filters, projects, aliases, orders, paginates, and caps scalar reads", async () => {
    const response = await app({ maxRows: 1 }).handle(
      request(
        "/records?tenant_id=eq.1&select=record_id:id,label:note&order=id.desc&limit=20",
        { headers: { "X-Request-Id": "read-basic" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBe("0-0/*");
    expect(response.headers.get("Range-Unit")).toBe("items");
    expect(response.headers.get("X-Request-Id")).toBe("read-basic");
    expect(await response.json()).toEqual([{ record_id: 2, label: "second" }]);
  });

  it("serializes every supported SQLite storage representation exactly", async () => {
    const first = await app().handle(request("/records?id=eq.1"));
    const second = await app().handle(request("/records?id=eq.2"));
    const third = await app().handle(request("/records?id=eq.3"));

    expect(await first.json()).toEqual([
      {
        id: 1,
        tenant_id: 1,
        unsafe_integer: 9007199254740991,
        ratio: 1.25,
        enabled: true,
        payload: { ok: true, n: 0.1 },
        bytes: "\\x00a5ff",
        note: "first",
      },
    ]);
    expect(await second.json()).toEqual([
      {
        id: 2,
        tenant_id: 1,
        unsafe_integer: "9007199254740992",
        ratio: 2.5,
        enabled: false,
        payload: null,
        bytes: null,
        note: "second",
      },
    ]);
    expect(
      ((await third.json()) as { unsafe_integer: unknown }[])[0]
        ?.unsafe_integer,
    ).toBe("9223372036854775807");
  });

  it("combines authorization and client filters so clients cannot weaken policy", async () => {
    let calls = 0;
    const authorized = app({
      auth: {
        authorize: () => {
          calls += 1;
          return {
            allowed: true,
            using: { field: "tenant_id", operator: "eq", value: 1 },
          };
        },
      },
    });
    const response = await authorized.handle(
      request("/records?or=(tenant_id.eq.2,id.eq.1)&order=id.asc"),
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { id: number }[]).map((row) => row.id),
    ).toEqual([1]);
    expect(calls).toBe(1);
  });

  it("returns exact totals, partial status, range errors, and empty query pages", async () => {
    const partial = await app().handle(
      request("/records?order=id.asc", {
        headers: { Prefer: "count=exact", Range: "1-1" },
      }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("1-1/3");
    expect(partial.headers.get("Preference-Applied")).toBe("count=exact");

    const queryEmpty = await app().handle(
      request("/records?offset=20", { headers: { Prefer: "count=exact" } }),
    );
    expect(queryEmpty.status).toBe(200);
    expect(queryEmpty.headers.get("Content-Range")).toBe("*/3");
    expect(await queryEmpty.json()).toEqual([]);

    const rangeError = await app().handle(
      request("/records", {
        headers: { Prefer: "count=exact", Range: "20-30" },
      }),
    );
    expect(rangeError.status).toBe(416);
    expect(rangeError.headers.get("Content-Range")).toBe("*/3");
    expect(await errorCode(rangeError)).toBe("SLREST109");
  });

  it("returns HEAD metadata without a body and resource-specific OPTIONS", async () => {
    const head = await app().handle(
      request("/records?limit=1", { method: "HEAD" }),
    );
    const tableOptions = await app().handle(
      request("/records", { method: "OPTIONS" }),
    );
    const viewOptions = await app().handle(
      request("/record_view", { method: "OPTIONS" }),
    );

    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Range")).toBe("0-0/*");
    expect(await head.text()).toBe("");
    expect(tableOptions.status).toBe(204);
    expect(tableOptions.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(viewOptions.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("enforces singular representations without silently choosing a row", async () => {
    const headers = { Accept: "application/vnd.pgrst.object+json" };
    const one = await app().handle(request("/records?id=eq.1", { headers }));
    const zero = await app().handle(request("/records?id=eq.99", { headers }));
    const many = await app().handle(request("/records", { headers }));

    expect(one.status).toBe(200);
    expect(one.headers.get("Content-Type")).toBe(
      "application/vnd.pgrst.object+json; charset=utf-8",
    );
    expect(((await one.json()) as { id: number }).id).toBe(1);
    expect(zero.status).toBe(406);
    expect(await errorCode(zero)).toBe("SLREST106");
    expect(many.status).toBe(406);
    expect(await errorCode(many)).toBe("SLREST106");
  });

  it("returns controlled failures for invalid stored BOOLEAN and JSON", async () => {
    try {
      database.run(
        "INSERT INTO records VALUES (4, 1, NULL, 1, 2, '{bad', NULL, 'invalid')",
      );
      const invalidBoolean = await app().handle(
        request("/records?id=eq.4&select=enabled"),
      );
      const invalidJson = await app().handle(
        request("/records?id=eq.4&select=payload"),
      );

      expect(invalidBoolean.status).toBe(500);
      expect(await errorCode(invalidBoolean)).toBe("SLREST501");
      expect(invalidJson.status).toBe(500);
      expect(await errorCode(invalidJson)).toBe("SLREST501");
    } finally {
      database.run("DELETE FROM records WHERE id = 4");
    }
  });

  it("quotes hostile schema identifiers while rejecting route and query injection", async () => {
    const quoted = await app().handle(
      request("/odd%22table?select=alias:odd%22column"),
    );
    const hostileResource = await app().handle(
      request("/records%22%3BDELETE%20FROM%20records%3B--"),
    );
    const hostileColumn = await app().handle(
      request("/records?select=id%22%3BDELETE%20FROM%20records%3B--"),
    );

    expect(await quoted.json()).toEqual([{ alias: "quoted" }]);
    expect(await errorCode(hostileResource)).toBe("SLREST200");
    expect(await errorCode(hostileColumn)).toBe("SLREST101");
    expect(
      database
        .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM records")
        .get()?.total,
    ).toBe(3);
  });

  it("rejects embedded reads, unknown/internal resources, extra paths, and unsupported methods", async () => {
    const embedded = await app().handle(
      request("/records?select=id,related(id)"),
    );
    const unknown = await app().handle(request("/missing"));
    const internal = await app().handle(request("/sqlite_sequence"));
    const extra = await app().handle(request("/records/1"));
    const trailing = await app().handle(request("/records/"));
    const mutation = await app().handle(
      request("/records", { method: "PATCH" }),
    );

    expect(await errorCode(embedded)).toBe("SLREST103");
    expect(await errorCode(unknown)).toBe("SLREST200");
    expect(await errorCode(internal)).toBe("SLREST200");
    expect(await errorCode(extra)).toBe("SLREST200");
    expect(await errorCode(trailing)).toBe("SLREST200");
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
  });
});
