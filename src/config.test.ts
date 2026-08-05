import { describe, expect, it } from "bun:test";

import { loadConfig } from "./config";

const defaultConfig = {
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 3000,
  maxRows: 1000,
  maxEmbedDepth: 5,
  maxBodyBytes: 1_048_576,
  busyTimeoutMs: 5000,
  corsOrigins: [],
  logLevel: "info",
} as const;

describe("loadConfig", () => {
  it.each(["./setupless.sqlite", "./setupless.db", ":memory:"])(
    "accepts the supported database path %s",
    (databasePath) => {
      expect(loadConfig({ DATABASE_PATH: databasePath })).toEqual({
        ...defaultConfig,
        databasePath,
      });
    },
  );

  it("returns a deeply immutable configuration snapshot", () => {
    const config = loadConfig({
      DATABASE_PATH: ":memory:",
      CORS_ORIGINS: "https://example.com",
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.corsOrigins)).toBe(true);
    expect(() =>
      (config.corsOrigins as string[]).push("https://other.test"),
    ).toThrow();
  });

  it("loads every supported value", () => {
    expect(
      loadConfig({
        DATABASE_PATH: " data.sqlite ",
        HOST: "::1",
        PORT: "65535",
        SETUPLESS_REST_API_KEY: " secret ",
        MAX_ROWS: "1000000",
        MAX_EMBED_DEPTH: "0",
        MAX_BODY_BYTES: "1073741824",
        SQLITE_BUSY_TIMEOUT_MS: "0",
        CORS_ORIGINS:
          " https://example.com, http://localhost:3000,https://example.com ",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({
      databasePath: "data.sqlite",
      host: "::1",
      port: 65_535,
      apiKey: "secret",
      maxRows: 1_000_000,
      maxEmbedDepth: 0,
      maxBodyBytes: 1_073_741_824,
      busyTimeoutMs: 0,
      corsOrigins: ["https://example.com", "http://localhost:3000"],
      logLevel: "debug",
    });
  });

  it.each([
    [undefined, "is required and must not be blank"],
    ["   ", "is required and must not be blank"],
    ["./setupless.txt", "must be :memory: or end in .sqlite or .db"],
  ])("rejects invalid DATABASE_PATH %p", (value, message) => {
    expect(() => loadConfig({ DATABASE_PATH: value })).toThrow(
      `DATABASE_PATH ${message}`,
    );
  });

  it.each(["", "host name", "https://example.com", "host/path", "-host"])(
    "rejects invalid HOST %p",
    (host) => {
      expect(() =>
        loadConfig({ DATABASE_PATH: ":memory:", HOST: host }),
      ).toThrow("HOST must be a hostname or IP address");
    },
  );

  it.each([
    ["PORT", "1", "65535"],
    ["MAX_ROWS", "1", "1000000"],
    ["MAX_EMBED_DEPTH", "0", "20"],
    ["MAX_BODY_BYTES", "1", "1073741824"],
    ["SQLITE_BUSY_TIMEOUT_MS", "0", "600000"],
  ])("accepts %s at both bounds", (variable, minimum, maximum) => {
    expect(
      loadConfig({ DATABASE_PATH: ":memory:", [variable]: minimum }),
    ).toBeDefined();
    expect(
      loadConfig({ DATABASE_PATH: ":memory:", [variable]: maximum }),
    ).toBeDefined();
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["MAX_ROWS", "0"],
    ["MAX_ROWS", "1000001"],
    ["MAX_EMBED_DEPTH", "21"],
    ["MAX_BODY_BYTES", "0"],
    ["MAX_BODY_BYTES", "1073741825"],
    ["SQLITE_BUSY_TIMEOUT_MS", "600001"],
  ])("rejects %s outside its bounds", (variable, value) => {
    expect(() =>
      loadConfig({ DATABASE_PATH: ":memory:", [variable]: value }),
    ).toThrow(variable);
  });

  it.each(["", " 1", "1 ", "+1", "-1", "1.0", "1e3", "NaN", "Infinity"])(
    "rejects malformed numeric value %p",
    (value) => {
      expect(() =>
        loadConfig({ DATABASE_PATH: ":memory:", MAX_ROWS: value }),
      ).toThrow("MAX_ROWS must be a base-10 integer");
    },
  );

  it.each([
    "*",
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "https://example.com,",
  ])("rejects invalid CORS origin input without echoing it: %p", (value) => {
    let error: unknown;

    try {
      loadConfig({ DATABASE_PATH: ":memory:", CORS_ORIGINS: value });
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain("CORS_ORIGINS");
    expect(String(error)).not.toContain(value);
  });

  it.each([undefined, "", "   "])(
    "treats a missing or blank API key as absent",
    (apiKey) => {
      expect(
        loadConfig({
          DATABASE_PATH: ":memory:",
          SETUPLESS_REST_API_KEY: apiKey,
        }),
      ).not.toHaveProperty("apiKey");
    },
  );

  it("does not echo secrets in other configuration errors", () => {
    const secret = "do-not-disclose-this-key";

    expect(() =>
      loadConfig({
        DATABASE_PATH: ":memory:",
        SETUPLESS_REST_API_KEY: secret,
        PORT: "invalid",
      }),
    ).toThrow("PORT");

    try {
      loadConfig({
        DATABASE_PATH: ":memory:",
        SETUPLESS_REST_API_KEY: secret,
        PORT: "invalid",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each(["trace", "INFO", ""])("rejects LOG_LEVEL %p", (logLevel) => {
    expect(() =>
      loadConfig({ DATABASE_PATH: ":memory:", LOG_LEVEL: logLevel }),
    ).toThrow("LOG_LEVEL must be debug, info, warn, or error");
  });
});
