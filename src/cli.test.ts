import { describe, expect, it } from "bun:test";
import { safeStartupMessage } from "./cli";
import { RestConfigError } from "./config";

describe("safeStartupMessage", () => {
  it("preserves canonical public startup failures", () => {
    expect(
      safeStartupMessage(
        new RestConfigError(
          "PORT must be a base-10 integer between 1 and 65535",
        ),
      ),
    ).toBe("PORT must be a base-10 integer between 1 and 65535");
    expect(
      safeStartupMessage(
        Error("SETUPLESS_REST_API_KEY is required and must not be blank"),
      ),
    ).toBe("SETUPLESS_REST_API_KEY is required and must not be blank");
  });

  it("redacts arbitrary messages that merely use a public prefix", () => {
    expect(
      safeStartupMessage(
        Error("DATABASE_PATH failed for /private/canary.sqlite"),
      ),
    ).toBe("Setupless/rest failed to start");
    expect(safeStartupMessage("PORT leaked detail")).toBe(
      "Setupless/rest failed to start",
    );
  });
});
