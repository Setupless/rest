import { describe, expect, it } from "bun:test";

import { RestError } from "../http/errors";
import { createApiKeyAuth } from "./api-key";
import type { RestAuthorizationContext } from "./types";

function context(authorization?: string): RestAuthorizationContext {
  return {
    request: new Request("http://setupless.test/records", {
      ...(authorization === undefined
        ? {}
        : { headers: { Authorization: authorization } }),
    }),
    table: "records",
    operation: "select",
  };
}

async function expectCode(
  action: () => unknown | Promise<unknown>,
  code: "SLREST300" | "SLREST301",
): Promise<void> {
  try {
    await action();
    throw Error("Expected authentication to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).code).toBe(code);
  }
}

describe("createApiKeyAuth", () => {
  it.each(["Bearer correct-token", "bearer correct-token"])(
    "accepts a matching %s credential",
    async (authorization) => {
      const plugin = createApiKeyAuth("correct-token");

      expect(await plugin.authorize(context(authorization))).toEqual({
        allowed: true,
      });
      expect(Object.isFrozen(plugin)).toBe(true);
    },
  );

  it.each([
    undefined,
    "",
    "Basic correct-token",
    "Bearer",
    "Bearer ",
    "Bearer  correct-token",
    "Bearer\tcorrect-token",
    "Bearer correct-token extra",
    "Bearer correct-token, Bearer correct-token",
    "Bearer invalid:token",
  ])("rejects missing or malformed authorization %p", async (authorization) => {
    const plugin = createApiKeyAuth("correct-token");

    await expectCode(
      () => plugin.authorize(context(authorization)),
      "SLREST300",
    );
  });

  it.each(["wrong-token", "x", "a-much-longer-wrong-token", "correct-tokeN"])(
    "timing-safely rejects the valid but unequal token %p",
    async (token) => {
      const plugin = createApiKeyAuth("correct-token");

      await expectCode(
        () => plugin.authorize(context(`Bearer ${token}`)),
        "SLREST301",
      );
    },
  );

  it.each(["", " ", "not valid", "invalid:token"])(
    "rejects unusable configured keys without echoing %p",
    (apiKey) => {
      let error: unknown;

      try {
        createApiKeyAuth(apiKey);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TypeError);
      if (apiKey.trim() !== "") expect(String(error)).not.toContain(apiKey);
    },
  );
});
