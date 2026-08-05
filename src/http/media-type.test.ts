import { describe, expect, it } from "bun:test";

import { RestError } from "./errors";
import {
  getResponseContentType,
  negotiateResponseMediaType,
  validateRequestMediaType,
} from "./media-type";

function accept(value?: string): Headers {
  return new Headers(value === undefined ? undefined : { Accept: value });
}

function contentType(value?: string): Headers {
  return new Headers(
    value === undefined ? undefined : { "Content-Type": value },
  );
}

describe("negotiateResponseMediaType", () => {
  it.each([
    [undefined, "json-array"],
    ["*/*", "json-array"],
    ["application/*", "json-array"],
    ["application/json", "json-array"],
    ['Application/JSON; Charset="UTF-8"', "json-array"],
    ["application/vnd.pgrst.object+json", "json-object"],
    ["APPLICATION/VND.PGRST.OBJECT+JSON;CHARSET=UTF-8", "json-object"],
  ] as const)("negotiates resource Accept %p as %s", (value, kind) => {
    expect(negotiateResponseMediaType(accept(value), "resource")).toEqual({
      kind,
    });
  });

  it.each([
    [undefined, "openapi"],
    ["*/*", "openapi"],
    ["application/*", "openapi"],
    ["application/openapi+json", "openapi"],
    ["application/json", "json-array"],
  ] as const)("negotiates root Accept %p as %s", (value, kind) => {
    expect(negotiateResponseMediaType(accept(value), "root")).toEqual({ kind });
  });

  it("honors quality, specificity, exclusions, and header order", () => {
    expect(
      negotiateResponseMediaType(
        accept(
          "application/json;q=0.2, application/vnd.pgrst.object+json;q=0.8",
        ),
        "resource",
      ),
    ).toEqual({ kind: "json-object" });
    expect(
      negotiateResponseMediaType(
        accept("application/json;q=0, */*;q=1"),
        "resource",
      ),
    ).toEqual({ kind: "json-object" });
    expect(
      negotiateResponseMediaType(
        accept(
          "application/vnd.pgrst.object+json;q=0.7, application/json;q=0.7",
        ),
        "resource",
      ),
    ).toEqual({ kind: "json-array" });
  });

  it("uses a supported range when unsupported ranges are also present", () => {
    expect(
      negotiateResponseMediaType(
        accept("text/csv, application/json;q=0.5"),
        "resource",
      ),
    ).toEqual({ kind: "json-array" });
  });

  it.each([
    "text/csv",
    "application/json;q=0",
    "application/json; charset=iso-8859-1",
    "application/vnd.pgrst.object+json",
  ])("rejects an unfulfillable response media type %p", (value) => {
    const endpoint =
      value === "application/vnd.pgrst.object+json" ? "root" : "resource";

    expect(() => negotiateResponseMediaType(accept(value), endpoint)).toThrow(
      expect.objectContaining({
        code: "SLREST105",
        status: 415,
        details: "Accept does not include a supported media type.",
      }),
    );
  });

  it.each([
    "",
    ",",
    "application",
    "*/json",
    "application/json; q=1.1",
    "application/json; q=0.1234",
    'application/json; charset="unterminated',
    "application/json; charset",
    "application/json; q=1; q=0.5",
    'application/json; profile="unescaped"quote"',
  ])("rejects malformed Accept %p without echoing it", (value) => {
    try {
      negotiateResponseMediaType(accept(value), "resource");
      throw new Error("Expected media negotiation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestError);
      expect(error).toMatchObject({
        code: "SLREST105",
        details: "Accept is malformed.",
      });
      if (value !== "") expect(String(error)).not.toContain(value);
    }
  });

  it("reports only media types supported by the selected endpoint", () => {
    try {
      negotiateResponseMediaType(accept("text/csv"), "root");
      throw new Error("Expected root media negotiation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestError);
      expect((error as RestError).hint).toContain("application/openapi+json");
      expect((error as RestError).hint).not.toContain(
        "application/vnd.pgrst.object+json",
      );
    }
  });
});

describe("validateRequestMediaType", () => {
  it.each([
    "application/json",
    "APPLICATION/JSON",
    "application/json; charset=utf-8",
    'application/json; CHARSET="UTF-8"',
  ])("accepts request Content-Type %p", (value) => {
    expect(() => validateRequestMediaType(contentType(value))).not.toThrow();
  });

  it.each([undefined, "", "   "])(
    "rejects a missing request Content-Type %p",
    (value) => {
      expect(() => validateRequestMediaType(contentType(value))).toThrow(
        expect.objectContaining({
          code: "SLREST105",
          details: "Content-Type is required for a request body.",
        }),
      );
    },
  );

  it.each([
    "text/plain",
    "application/vnd.pgrst.object+json",
    "application/json; charset=utf8",
    "application/json; charset=iso-8859-1",
    "application/json; profile=custom",
  ])("rejects unsupported request Content-Type %p", (value) => {
    expect(() => validateRequestMediaType(contentType(value))).toThrow(
      expect.objectContaining({
        code: "SLREST105",
        status: 415,
        details: "Content-Type does not include a supported media type.",
      }),
    );
  });

  it.each([
    "application/json, text/plain",
    "application",
    "*/json",
    "application/json; charset",
    'application/json; charset="unterminated',
    "application/json; q=1",
  ])("rejects malformed request Content-Type %p", (value) => {
    expect(() => validateRequestMediaType(contentType(value))).toThrow(
      expect.objectContaining({
        code: "SLREST105",
        details: "Content-Type is malformed.",
      }),
    );
  });
});

describe("getResponseContentType", () => {
  it.each([
    ["json-array", "application/json; charset=utf-8"],
    ["json-object", "application/vnd.pgrst.object+json; charset=utf-8"],
    ["openapi", "application/openapi+json; charset=utf-8"],
  ] as const)("formats %s", (kind, expected) => {
    expect(getResponseContentType({ kind })).toBe(expected);
  });
});
