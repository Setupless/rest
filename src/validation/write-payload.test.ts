import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DatabaseResource, loadDatabaseSchema } from "../database/schema";
import { RestError } from "../http/errors";
import { parseInsertPayload } from "./write-payload";

const SCHEMA = `
  CREATE TABLE values_example (
    id INTEGER PRIMARY KEY,
    enabled BOOLEAN,
    payload JSON,
    exact_integer INTEGER,
    ratio REAL,
    label TEXT,
    bytes BLOB,
    amount NUMERIC,
    generated TEXT GENERATED ALWAYS AS (label || '!') STORED
  );
`;

describe("write payload validation", () => {
  let database: Database;
  let resource: DatabaseResource;

  beforeEach(() => {
    database = new Database(":memory:", { strict: true });
    database.run(SCHEMA);
    const loaded = loadDatabaseSchema(database).getResource("values_example");
    if (loaded === undefined) throw new Error("missing test resource");
    resource = loaded;
  });

  afterEach(() => database.close());

  it("normalizes every supported request representation without lossy coercion", () => {
    const payload = parseInsertPayload(
      JSON.stringify({
        id: "9223372036854775807",
        enabled: false,
        payload: { nested: [1, null, "9007199254740993"] },
        exact_integer: 42,
        ratio: 2.5,
        label: "written",
        bytes: "\\xDeAdBeEf",
        amount: "retained",
      }),
      resource,
      "default",
    );

    expect(Array.isArray(payload)).toBe(false);
    expect(payload).toMatchObject({
      id: 9223372036854775807n,
      enabled: 0,
      payload: '{"nested":[1,null,"9007199254740993"]}',
      exact_integer: 42,
      ratio: 2.5,
      label: "written",
      amount: "retained",
    });
    expect((payload as { bytes: Uint8Array }).bytes).toEqual(
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  it("rejects unsafe numeric tokens before JavaScript can round them", () => {
    for (const source of [
      '{"exact_integer":9007199254740993}',
      '{"ratio":0.10000000000000001}',
      '{"payload":{"n":9007199254740993}}',
      '{"amount":1e309}',
    ]) {
      expect(() => parseInsertPayload(source, resource, "default")).toThrow(
        RestError,
      );
      try {
        parseInsertPayload(source, resource, "default");
      } catch (error) {
        expect((error as RestError).code).toBe("SLREST403");
      }
    }
  });

  it("applies missing semantics and requires one effective bulk column set", () => {
    expect(parseInsertPayload('{"label":"one"}', resource, "null")).toEqual({
      id: null,
      enabled: null,
      payload: null,
      exact_integer: null,
      ratio: null,
      label: "one",
      bytes: null,
      amount: null,
    });
    expect(
      parseInsertPayload(
        '[{"label":"one"},{"label":"two"}]',
        resource,
        "default",
      ),
    ).toEqual([{ label: "one" }, { label: "two" }]);
    expect(() =>
      parseInsertPayload(
        '[{"label":"one"},{"label":"two","ratio":2}]',
        resource,
        "default",
      ),
    ).toThrow(RestError);
  });

  it("rejects invalid top-level shapes, bulk members, and malformed JSON", () => {
    for (const source of ["null", "1", '"value"', "[]", "[{} , null]", "{"]) {
      try {
        parseInsertPayload(source, resource, "default");
        throw new Error("expected payload failure");
      } catch (error) {
        expect((error as RestError).code).toBe("SLREST107");
      }
    }
  });

  it("resolves columns case-insensitively and rejects unknown or generated writes", () => {
    expect(parseInsertPayload('{"LABEL":"ok"}', resource, "default")).toEqual({
      label: "ok",
    });
    for (const [source, code] of [
      ['{"missing":1}', "SLREST101"],
      ['{"generated":"value"}', "SLREST206"],
      ['{"label":"one","LABEL":"two"}', "SLREST107"],
    ] as const) {
      try {
        parseInsertPayload(source, resource, "default");
        throw new Error("expected column failure");
      } catch (error) {
        expect((error as RestError).code).toBe(code);
      }
    }
  });
});
