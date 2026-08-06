import { RestError } from "../http/errors";
import {
  andFilters,
  DEFAULT_FILTER_MAX_DEPTH,
  type RestFilter,
  validateRestFilter,
} from "../query/filter";
import { isApiKeyAuth, isApiKeyAuthError } from "./api-key";
import type {
  AuthorizationDecision,
  ResolveAuthorizationOptions,
  RestAuthorizationContext,
  RestAuthorizationResolver,
  RestAuthPlugin,
  RestOperation,
} from "./types";

interface AllowedPolicy {
  readonly using?: RestFilter;
  readonly check?: RestFilter;
}

const ALLOW_ALL = Object.freeze({}) satisfies AllowedPolicy;
const OPERATIONS = new Set<RestOperation>([
  "select",
  "insert",
  "update",
  "delete",
]);

function authorizationFailure(): RestError<"SLREST304"> {
  return new RestError("SLREST304");
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw authorizationFailure();
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function snapshotFilter(
  filter: RestFilter,
  resource: ResolveAuthorizationOptions["resource"],
  maxFilterDepth: number,
): RestFilter {
  const snapshot = structuredClone(filter) as RestFilter;
  validateRestFilter(snapshot, resource, maxFilterDepth);

  const freezeNode = (node: RestFilter): RestFilter => {
    if ("field" in node) {
      if (Array.isArray(node.value)) Object.freeze(node.value);
      return Object.freeze(node);
    }
    if ("not" in node) {
      freezeNode(node.not);
      return Object.freeze(node);
    }

    const children = "and" in node ? node.and : node.or;
    for (const child of children) freezeNode(child);
    Object.freeze(children);
    return Object.freeze(node);
  };

  return freezeNode(snapshot);
}

function normalizeDecision(
  pluginDecision: AuthorizationDecision,
  resource: ResolveAuthorizationOptions["resource"],
  operation: RestOperation,
  maxFilterDepth: number,
): AllowedPolicy {
  const value = structuredClone(pluginDecision) as AuthorizationDecision;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw authorizationFailure();
  }

  if (value.allowed === false) {
    const expectedKeys = hasOwn(value, "status")
      ? ["allowed", "status"]
      : ["allowed"];
    assertExactKeys(value, expectedKeys);
    if (
      value.status !== undefined &&
      value.status !== 401 &&
      value.status !== 403
    ) {
      throw authorizationFailure();
    }

    if (value.status === 401) throw new RestError("SLREST302");
    throw new RestError("SLREST303", {
      details: `The ${operation} operation is forbidden for resource ${JSON.stringify(resource.name)}.`,
    });
  }

  if (value.allowed !== true) throw authorizationFailure();

  const expectedKeys = [
    "allowed",
    ...(hasOwn(value, "using") ? ["using"] : []),
    ...(hasOwn(value, "check") ? ["check"] : []),
  ];
  assertExactKeys(value, expectedKeys);

  const using =
    value.using === undefined
      ? undefined
      : snapshotFilter(value.using, resource, maxFilterDepth);
  const check =
    value.check === undefined
      ? undefined
      : snapshotFilter(value.check, resource, maxFilterDepth);

  return Object.freeze({
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  });
}

function createPluginContext(
  request: Request,
  table: string,
  operation: RestOperation,
): RestAuthorizationContext {
  const requestClone = new Request(request);
  Object.freeze(requestClone);
  const context: RestAuthorizationContext = {
    request: requestClone,
    table,
    operation,
  };
  return Object.freeze(context);
}

function validateResolverOptions(
  { request, resource, operation }: ResolveAuthorizationOptions,
  maxFilterDepth: number,
): void {
  if (!(request instanceof Request)) {
    throw new TypeError("request must be a Request");
  }
  if (typeof resource !== "object" || resource === null) {
    throw new TypeError("resource must be startup database metadata");
  }
  if (!OPERATIONS.has(operation)) {
    throw new TypeError("operation must be select, insert, update, or delete");
  }
  if (!Number.isSafeInteger(maxFilterDepth) || maxFilterDepth < 0) {
    throw new TypeError("maxFilterDepth must be a non-negative safe integer");
  }
}

/** Builds one cached, fail-closed authorization facade for an application. */
export function createAuthorizationResolver(
  auth?: RestAuthPlugin,
  maxFilterDepth = DEFAULT_FILTER_MAX_DEPTH,
): RestAuthorizationResolver {
  if (
    auth !== undefined &&
    (typeof auth !== "object" ||
      auth === null ||
      typeof auth.authorize !== "function")
  ) {
    throw new TypeError("auth must be a RestAuthPlugin");
  }
  if (!Number.isSafeInteger(maxFilterDepth) || maxFilterDepth < 0) {
    throw new TypeError("maxFilterDepth must be a non-negative safe integer");
  }

  const cache = new WeakMap<
    Request,
    Map<string, Map<RestOperation, Promise<AllowedPolicy>>>
  >();
  const authorize = auth?.authorize.bind(auth);

  const getPolicy = (
    request: Request,
    resource: ResolveAuthorizationOptions["resource"],
    operation: RestOperation,
  ): Promise<AllowedPolicy> => {
    if (!auth || !authorize) return Promise.resolve(ALLOW_ALL);

    let resources = cache.get(request);
    if (!resources) {
      resources = new Map();
      cache.set(request, resources);
    }
    let operations = resources.get(resource.name);
    if (!operations) {
      operations = new Map();
      resources.set(resource.name, operations);
    }

    const cached = operations.get(operation);
    if (cached) return cached;

    const policy = (async () => {
      let decision: AuthorizationDecision;

      try {
        const context = createPluginContext(request, resource.name, operation);
        decision = await authorize(context);
      } catch (error) {
        if (isApiKeyAuth(auth) && isApiKeyAuthError(error)) throw error;
        throw authorizationFailure();
      }

      try {
        return normalizeDecision(decision, resource, operation, maxFilterDepth);
      } catch (error) {
        if (
          error instanceof RestError &&
          (error.code === "SLREST302" || error.code === "SLREST303")
        ) {
          throw error;
        }
        throw authorizationFailure();
      }
    })();
    operations.set(operation, policy);
    return policy;
  };

  return Object.freeze({
    mode: auth ? (isApiKeyAuth(auth) ? "api-key" : "programmatic") : "none",
    async resolve(options: ResolveAuthorizationOptions) {
      validateResolverOptions(options, maxFilterDepth);
      const clientFilter =
        options.clientFilter === undefined
          ? undefined
          : snapshotFilter(
              options.clientFilter,
              options.resource,
              maxFilterDepth,
            );
      const policy = await getPolicy(
        options.request,
        options.resource,
        options.operation,
      );
      const using =
        options.operation === "insert"
          ? undefined
          : andFilters(clientFilter, policy.using);
      const check =
        options.operation === "insert" || options.operation === "update"
          ? policy.check
          : undefined;

      if (using !== undefined) {
        validateRestFilter(using, options.resource, maxFilterDepth);
      }

      return Object.freeze({
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    },
  });
}
