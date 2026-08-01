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
});
