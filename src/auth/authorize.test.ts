import { describe, expect, it } from "bun:test";

import { FILTER_RESOURCE } from "../../test/filter-fixture";
import { RestError } from "../http/errors";
import type { RestFilter } from "../query/filter";
import { compileRestFilter } from "../query/filter-compiler";
import { createApiKeyAuth } from "./api-key";
import { createAuthorizationResolver } from "./authorize";
import type {
  AuthorizationDecision,
  RestAuthPlugin,
  RestOperation,
} from "./types";

const CLIENT_FILTER: RestFilter = {
  field: "id",
  operator: "gte",
  value: 10,
};
const USING_FILTER: RestFilter = {
  field: "title",
  operator: "eq",
  value: "public",
};
const CHECK_FILTER: RestFilter = {
  field: "done",
  operator: "is",
  value: false,
};

function request(method = "GET"): Request {
  return new Request("http://setupless.test/records?private=value", {
    method,
    headers: { Authorization: "Custom private-credential" },
  });
}

function options(
  inbound: Request,
  operation: RestOperation = "select",
  clientFilter: RestFilter | undefined = CLIENT_FILTER,
) {
  return {
    request: inbound,
    resource: FILTER_RESOURCE,
    operation,
    ...(clientFilter === undefined ? {} : { clientFilter }),
  };
}

async function expectRestError(
  action: () => unknown | Promise<unknown>,
  code: RestError["code"],
): Promise<RestError> {
  try {
    await action();
    throw Error("Expected authorization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).code).toBe(code);
    return error as RestError;
  }
}

describe("createAuthorizationResolver", () => {
  it("allows a direct app with no plugin and snapshots client filters", async () => {
    const resolver = createAuthorizationResolver();
    const inbound = request();
    const result = await resolver.resolve(options(inbound));

    expect(resolver.mode).toBe("none");
    expect(result).toEqual({ using: CLIENT_FILTER });
    expect(result.using).not.toBe(CLIENT_FILTER);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.using)).toBe(true);
  });

  it.each([
    ["select", { using: { and: [CLIENT_FILTER, USING_FILTER] } }],
    [
      "update",
      {
        using: { and: [CLIENT_FILTER, USING_FILTER] },
        check: CHECK_FILTER,
      },
    ],
    ["delete", { using: { and: [CLIENT_FILTER, USING_FILTER] } }],
    ["insert", { check: CHECK_FILTER }],
  ] as const)(
    "applies only the %s policy phases",
    async (operation, expected) => {
      const resolver = createAuthorizationResolver({
        authorize: () => ({
          allowed: true,
          using: USING_FILTER,
          check: CHECK_FILTER,
        }),
      });

      await expect(
        resolver.resolve(options(request(), operation)),
      ).resolves.toEqual(expected);
    },
  );

  it("deeply freezes the composed client and policy using filter", async () => {
    const resolver = createAuthorizationResolver({
      authorize: () => ({ allowed: true, using: USING_FILTER }),
    });
    const result = await resolver.resolve(options(request()));
    const composed = result.using as Extract<RestFilter, { and: unknown }>;

    expect(Object.isFrozen(composed)).toBe(true);
    expect(Object.isFrozen(composed.and)).toBe(true);
    expect(composed.and.every((filter) => Object.isFrozen(filter))).toBe(true);
  });

  it("supports asynchronous plugins and caches by request/resource/operation", async () => {
    const calls: string[] = [];
    const plugin: RestAuthPlugin = {
      async authorize({ table, operation }) {
        await Promise.resolve();
        calls.push(`${table}:${operation}`);
        return { allowed: true };
      },
    };
    const resolver = createAuthorizationResolver(plugin);
    const inbound = request();

    await Promise.all([
      resolver.resolve(options(inbound)),
      resolver.resolve(options(inbound, "select", USING_FILTER)),
      resolver.resolve(options(inbound, "update")),
    ]);
    await resolver.resolve({
      ...options(inbound),
      resource: { ...FILTER_RESOURCE, name: "other_records" },
    });

    expect(calls).toEqual([
      "records:select",
      "records:update",
      "other_records:select",
    ]);
    expect(resolver.mode).toBe("programmatic");
  });

  it.each([
    [undefined, "SLREST300"],
    ["Bearer wrong", "SLREST301"],
  ] as const)(
    "preserves stock credential failure %s as %s",
    async (authorization, code) => {
      const resolver = createAuthorizationResolver(createApiKeyAuth("correct"));
      const inbound = new Request("http://setupless.test/records", {
        ...(authorization === undefined
          ? {}
          : { headers: { Authorization: authorization } }),
      });

      expect(resolver.mode).toBe("api-key");
      await expectRestError(() => resolver.resolve(options(inbound)), code);
    },
  );

  it("passes an immutable complete request clone without mutating the original", async () => {
    const inbound = new Request("http://setupless.test/records?visible=yes", {
      method: "POST",
      headers: {
        Authorization: "Custom secret",
        "Content-Type": "text/plain",
      },
      body: "payload",
    });
    let pluginRequest: Request | undefined;
    let contextFrozen = false;
    const resolver = createAuthorizationResolver({
      async authorize(context) {
        pluginRequest = context.request;
        contextFrozen = Object.isFrozen(context);
        expect(Object.isFrozen(context.request)).toBe(true);
        expect(context.request.url).toBe(inbound.url);
        expect(context.request.method).toBe("POST");
        expect(context.request.headers.get("Authorization")).toBe(
          "Custom secret",
        );
        expect(await context.request.text()).toBe("payload");
        context.request.headers.set("Authorization", "mutated");
        return { allowed: true };
      },
    });

    await resolver.resolve(options(inbound, "insert", undefined));

    expect(contextFrozen).toBe(true);
    expect(pluginRequest).not.toBe(inbound);
    expect(inbound.headers.get("Authorization")).toBe("Custom secret");
    expect(await inbound.text()).toBe("payload");
  });

  it.each([
    [{ allowed: false }, "SLREST303", 403],
    [{ allowed: false, status: 403 }, "SLREST303", 403],
    [{ allowed: false, status: 401 }, "SLREST302", 401],
  ] as const)(
    "maps the plugin denial %p to %s",
    async (decision, code, status) => {
      const resolver = createAuthorizationResolver({
        authorize: () => decision,
      });
      const error = await expectRestError(
        () => resolver.resolve(options(request())),
        code,
      );

      expect(error.status).toBe(status);
      if (code === "SLREST303") {
        expect(error.details).toContain("records");
        expect(error.details).toContain("select");
      } else {
        expect(error.details).toBeNull();
      }
    },
  );

  it.each([
    null,
    {},
    { allowed: "yes" },
    { allowed: true, extra: true },
    { allowed: false, status: 402 },
    { allowed: false, using: USING_FILTER },
  ])("fails closed for the invalid decision %p", async (decision) => {
    const resolver = createAuthorizationResolver({
      authorize: () => decision as AuthorizationDecision,
    });

    const error = await expectRestError(
      () => resolver.resolve(options(request())),
      "SLREST304",
    );
    expect(error.details).toBeNull();
    expect(error.hint).toBeNull();
  });

  it.each([
    () => {
      throw Error("private plugin failure");
    },
    () => Promise.reject(Error("private async failure")),
    () => {
      throw new RestError("SLREST303", {
        details: "plugin-controlled disclosure",
      });
    },
  ])("sanitizes thrown and rejected plugin internals", async (authorize) => {
    const resolver = createAuthorizationResolver({ authorize });

    const error = await expectRestError(
      () => resolver.resolve(options(request())),
      "SLREST304",
    );
    expect(error.details).toBeNull();
    expect(error.hint).toBeNull();
  });

  it.each([
    { field: "missing", operator: "eq", value: 1 },
    { field: "id", operator: "eq", value: "not-an-integer" },
    { and: [] },
  ])("fails closed for the invalid policy filter %p", async (using) => {
    const resolver = createAuthorizationResolver({
      authorize: () => ({
        allowed: true,
        using: using as RestFilter,
      }),
    });

    await expectRestError(
      () => resolver.resolve(options(request())),
      "SLREST304",
    );
  });

  it("fails closed for cyclic policy filters without leaking the cycle", async () => {
    const cyclic = { not: undefined } as unknown as { not: RestFilter };
    cyclic.not = cyclic;
    const resolver = createAuthorizationResolver({
      authorize: () => ({ allowed: true, using: cyclic }),
    });

    await expectRestError(
      () => resolver.resolve(options(request())),
      "SLREST304",
    );
  });

  it("keeps client validation distinct and does not invoke the plugin", async () => {
    let calls = 0;
    const resolver = createAuthorizationResolver({
      authorize() {
        calls += 1;
        return { allowed: true };
      },
    });

    await expectRestError(
      () =>
        resolver.resolve(
          options(request(), "select", {
            field: "missing",
            operator: "eq",
            value: 1,
          }),
        ),
      "SLREST101",
    );
    expect(calls).toBe(0);
  });

  it("snapshots plugin filters before returning them to handlers", async () => {
    const mutable = {
      field: "title",
      operator: "eq",
      value: "before",
    } as RestFilter;
    const resolver = createAuthorizationResolver({
      authorize: () => ({ allowed: true, using: mutable }),
    });

    const result = await resolver.resolve({
      request: request(),
      resource: FILTER_RESOURCE,
      operation: "select",
    });
    (mutable as { value: string }).value = "after";

    expect(result.using).toEqual({
      field: "title",
      operator: "eq",
      value: "before",
    });
    expect(Object.isFrozen(result.using)).toBe(true);
  });

  it("keeps client and hostile policy values bound after composition", async () => {
    const hostile = '" OR 1=1 --';
    const resolver = createAuthorizationResolver({
      authorize: () => ({
        allowed: true,
        using: { field: "title", operator: "eq", value: hostile },
      }),
    });
    const result = await resolver.resolve(options(request()));
    const compiled = compileRestFilter(
      result.using as RestFilter,
      FILTER_RESOURCE,
      "records",
    );

    expect(compiled.sql).not.toContain(hostile);
    expect(compiled.parameters).toEqual([10, hostile]);
  });

  it("caches failed decisions so aliases cannot repeatedly invoke a plugin", async () => {
    let calls = 0;
    const resolver = createAuthorizationResolver({
      authorize() {
        calls += 1;
        throw Error("private");
      },
    });
    const inbound = request();

    await expectRestError(
      () => resolver.resolve(options(inbound)),
      "SLREST304",
    );
    await expectRestError(
      () => resolver.resolve(options(inbound)),
      "SLREST304",
    );
    expect(calls).toBe(1);
  });

  it("rejects invalid resolver construction and call arguments", async () => {
    expect(() => createAuthorizationResolver(undefined, -1)).toThrow(TypeError);
    expect(() => createAuthorizationResolver("invalid" as never)).toThrow(
      TypeError,
    );
    expect(() => createAuthorizationResolver({} as RestAuthPlugin)).toThrow(
      TypeError,
    );

    const resolver = createAuthorizationResolver();
    await expect(
      resolver.resolve({
        ...options(request()),
        operation: "execute" as RestOperation,
      }),
    ).rejects.toThrow(TypeError);
  });
});
