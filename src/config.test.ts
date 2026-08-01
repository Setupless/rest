import { describe, expect, it } from "bun:test";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  it.each(["./setupless.sqlite", "./setupless.db", ":memory:"])(
    "accepts the supported database path %s",
    (databasePath) => {
      expect(loadConfig({ DATABASE_PATH: databasePath })).toEqual({
        databasePath,
        port: 3000,
      });
    },
  );

  it("rejects an unsupported database suffix", () => {
    expect(() => loadConfig({ DATABASE_PATH: "./setupless.txt" })).toThrow(
      "DATABASE_PATH is required and must end in .sqlite or .db",
    );
  });

  it("rejects a fractional port", () => {
    expect(() =>
      loadConfig({ DATABASE_PATH: ":memory:", PORT: "3000.5" }),
    ).toThrow("PORT must be an integer between 1 and 65535 if present");
  });
});
