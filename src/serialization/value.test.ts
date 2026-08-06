import { describe, expect, it } from "bun:test";
import type { DatabaseColumn } from "../database/schema";
import { RestError } from "../http/errors";
import { serializeSQLiteValue } from "./value";

function column(
  declaredType: string,
  affinity: DatabaseColumn["affinity"],
): DatabaseColumn {
  return {
    cid: 0,
    name: "value",
    declaredType,
    affinity,
    nullable: true,
    defaultValue: null,
    primaryKeyPosition: null,
    generated: false,
    writable: true,
  };
}

describe("serializeSQLiteValue", () => {
  it("preserves null, text, finite real, and exact integer values", () => {
    const integer = column("INTEGER", "integer");
    const real = column("REAL", "real");
    const text = column("TEXT", "text");

    expect(serializeSQLiteValue(null, integer)).toBeNull();
    expect(serializeSQLiteValue("plain", text)).toBe("plain");
    expect(serializeSQLiteValue(1.25, real)).toBe(1.25);
    expect(serializeSQLiteValue(-0, real)).toBe(0);
    expect(serializeSQLiteValue(9007199254740991n, integer)).toBe(
      9007199254740991,
    );
    expect(serializeSQLiteValue(9007199254740992n, integer)).toBe(
      "9007199254740992",
    );
    expect(serializeSQLiteValue(-9223372036854775808n, integer)).toBe(
      "-9223372036854775808",
    );
  });

  it("serializes copied BLOB bytes as lowercase prefixed hex", () => {
    const bytes = new Uint8Array([0, 0xa5, 0xff]);

    expect(serializeSQLiteValue(bytes, column("BLOB", "blob"))).toBe(
      "\\x00a5ff",
    );
    expect(bytes).toEqual(new Uint8Array([0, 0xa5, 0xff]));
  });

  it("accepts only integer zero and one for declared BOOLEAN", () => {
    const boolean = column(" BOOLEAN ", "numeric");

    expect(serializeSQLiteValue(0n, boolean)).toBe(false);
    expect(serializeSQLiteValue(1n, boolean)).toBe(true);
    expect(() => serializeSQLiteValue(1, boolean, "records", "real")).toThrow(
      RestError,
    );
    for (const value of [2n, "1", 0.0 + 0.5]) {
      expect(() => serializeSQLiteValue(value, boolean)).toThrow(RestError);
    }
  });

  it("parses declared JSON only when every numeric token is lossless", () => {
    const json = column("json", "numeric");

    expect(
      serializeSQLiteValue(
        '{"safe":[0.1,1e3,9007199254740991],"large":"9007199254740992"}',
        json,
      ),
    ).toEqual({
      safe: [0.1, 1000, 9007199254740991],
      large: "9007199254740992",
    });
    for (const value of [
      '{"n":9007199254740992}',
      '{"n":0.10000000000000001}',
      '{"n":1e309}',
      "not-json",
      new Uint8Array([1]),
    ]) {
      try {
        serializeSQLiteValue(value, json, "records");
        throw new Error("Expected serialization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(RestError);
        expect((error as RestError).code).toBe("SLREST501");
        expect((error as RestError).details).not.toContain(String(value));
      }
    }
    expect(() => serializeSQLiteValue("{}", json, "records", "blob")).toThrow(
      RestError,
    );
  });

  it("rejects unavailable exact integers and non-finite reals", () => {
    for (const value of [
      9007199254740992,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        serializeSQLiteValue(value, column("NUMERIC", "numeric")),
      ).toThrow(RestError);
    }
  });
});
