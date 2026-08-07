import type { SQLQueryBindings } from "bun:sqlite";
import type {
  ResolvedAuthorization,
  RestAuthorizationResolver,
} from "../auth/types";
import type { Database } from "../database/database";
import { foldSQLiteIdentifier } from "../database/identifier";
import type { DatabaseRelationshipGraph } from "../database/relationships";
import type {
  DatabaseColumn,
  DatabaseResource,
  DatabaseSchema,
} from "../database/schema";
import { executeDelete } from "../execution/delete";
import { executeInsert, type MutationResult } from "../execution/insert";
import { executeRead, type ReadExecutionResult } from "../execution/read";
import { executeRelationRead } from "../execution/relations";
import { executeUpdate } from "../execution/update";
import {
  type AuthorizationPhase,
  executeUpsert,
  resolveConflictTarget,
} from "../execution/upsert";
import { RestError, toErrorResponse } from "../http/errors";
import {
  getResponseContentType,
  negotiateResponseMediaType,
  type RestMediaType,
  validateRequestMediaType,
} from "../http/media-type";
import {
  getPreferenceApplied,
  parsePreferences,
  type RestPreferences,
} from "../http/preferences";
import type { RestFilter, RestScalar } from "../query/filter";
import {
  parseRestQuery,
  type RestQuery,
  type RestQueryConfig,
} from "../query/query";
import {
  parseInsertPayload,
  parsePutPayload,
  parseUpdatePatch,
} from "../validation/write-payload";

export interface ResourceRouteDependencies {
  readonly database: Database;
  readonly schema: DatabaseSchema;
  readonly relationships: DatabaseRelationshipGraph;
  readonly authorization: RestAuthorizationResolver;
  readonly queryConfig: RestQueryConfig;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const READ_ONLY_METHODS = "GET, HEAD, OPTIONS";
const WRITE_METHODS = "GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT";

function requestId(request: Request): string {
  const supplied = request.headers.get("X-Request-Id");
  return supplied !== null && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function resolveResource(
  schema: DatabaseSchema,
  name: string,
): DatabaseResource | undefined {
  const direct = schema.getResource(name);
  if (direct) return direct;
  const identifier = foldSQLiteIdentifier(name);
  return schema
    .listResources()
    .find((resource) => foldSQLiteIdentifier(resource.name) === identifier);
}

function getResourceName(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (
    !pathname.startsWith("/") ||
    pathname.length < 2 ||
    pathname.slice(1).includes("/")
  ) {
    throw new RestError("SLREST200", {
      details: "The request path is not a resource collection route.",
      hint: "Use exactly one URL-encoded resource path segment.",
    });
  }

  try {
    const decoded = decodeURIComponent(pathname.slice(1));
    if (!decoded || decoded.includes("/")) {
      throw new RestError("SLREST200", {
        details: "The request path is not a resource collection route.",
        hint: "Use exactly one URL-encoded resource path segment.",
      });
    }
    return decoded;
  } catch (error) {
    if (error instanceof RestError) throw error;
    throw new RestError("SLREST100", {
      details: "The resource path contains invalid percent encoding or UTF-8.",
      hint: "Percent-encode the resource name as UTF-8.",
    });
  }
}

function getOptionsAllow(resource: DatabaseResource): string {
  return resource.writable ? WRITE_METHODS : READ_ONLY_METHODS;
}

function hasEmbeddedSelection(query: RestQuery): boolean {
  return query.selection.some((selection) => selection.kind === "relation");
}

function rejectEmbeddedSelection(query: RestQuery): void {
  if (query.selection.some((selection) => selection.kind === "relation")) {
    throw new RestError("SLREST103", {
      details: "Embedded relation selection is not available for scalar reads.",
      hint: "Select scalar columns only until relation execution is enabled.",
    });
  }
}

function getContentRange(result: ReadExecutionResult): string {
  if (result.rangeEnd === null) return `*/${result.total ?? "*"}`;
  return `${result.rangeStart}-${result.rangeEnd}/${result.total ?? "*"}`;
}

function getReadStatus(result: ReadExecutionResult): number {
  if (
    result.total !== null &&
    result.rows.length > 0 &&
    (result.rangeStart > 0 || result.rows.length < result.total)
  ) {
    return 206;
  }
  return 200;
}

function singularResult(
  result: ReadExecutionResult,
): Readonly<Record<string, unknown>> {
  const row = result.rows[0];
  if (result.rows.length === 1 && row !== undefined) return row;
  throw new RestError("SLREST106", {
    details:
      result.rows.length === 0
        ? "The authorized query returned zero rows."
        : "The authorized query returned more than one row.",
    hint: "Refine the query so it returns exactly one row.",
  });
}

function jsonBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new RestError("SLREST504");
  }
}

function createMutationResponse(options: {
  readonly result: MutationResult;
  readonly query: RestQuery;
  readonly preferences: RestPreferences;
  readonly mediaType: RestMediaType;
  readonly preferenceApplied: string | null;
  readonly requestId: string;
  readonly status: number;
}): Response {
  const headers = new Headers({ "X-Request-Id": options.requestId });
  if (options.preferenceApplied !== null) {
    headers.set("Preference-Applied", options.preferenceApplied);
  }
  if (options.preferences.count === "exact") {
    headers.set("Range-Unit", "items");
    headers.set(
      "Content-Range",
      options.result.affected === 0
        ? "*/0"
        : `0-${options.result.affected - 1}/${options.result.affected}`,
    );
  }

  let body: string | null = null;
  if (options.preferences.return === "representation") {
    headers.set("Content-Type", getResponseContentType(options.mediaType));
    body = jsonBody(
      options.query.singular ? options.result.rows[0] : options.result.rows,
    );
  }
  return new Response(body, { status: options.status, headers });
}

async function handleRead(
  request: Request,
  resource: DatabaseResource,
  dependencies: ResourceRouteDependencies,
  id: string,
): Promise<Response> {
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const preferences = parsePreferences(request.headers);
  const preferenceApplied = getPreferenceApplied(preferences, method);
  const mediaType = negotiateResponseMediaType(request.headers, "resource");
  const query = parseRestQuery(
    request,
    resource,
    dependencies.schema,
    dependencies.queryConfig,
    dependencies.relationships,
  );
  const authorization = await dependencies.authorization.resolve({
    request,
    resource,
    operation: "select",
    ...(query.filter === undefined ? {} : { clientFilter: query.filter }),
  });
  const executionQuery =
    query.singular && query.limit > 2
      ? Object.freeze({ ...query, limit: 2 })
      : query;
  const result = hasEmbeddedSelection(query)
    ? await executeRelationRead(
        {
          ...dependencies,
          request,
          config: dependencies.queryConfig,
        },
        resource,
        executionQuery,
        authorization,
      )
    : executeRead(
        dependencies.database,
        resource,
        executionQuery,
        authorization,
      );
  const representation = query.singular ? singularResult(result) : result.rows;
  const headers = new Headers({
    "Content-Range": getContentRange(result),
    "Content-Type": getResponseContentType(mediaType),
    "Range-Unit": "items",
    "X-Request-Id": id,
  });
  if (preferenceApplied !== null) {
    headers.set("Preference-Applied", preferenceApplied);
  }

  return new Response(method === "HEAD" ? null : jsonBody(representation), {
    status: getReadStatus(result),
    headers,
  });
}

function getOnConflict(request: Request): string | undefined {
  const url = new URL(request.url);
  const values = url.searchParams.getAll("on_conflict");
  if (values.length > 1) {
    throw new RestError("SLREST113", {
      details: "on_conflict must not be repeated.",
      hint: "Provide one comma-separated conflict target.",
    });
  }
  return values[0];
}

function assertInsertControls(request: Request, upsert: boolean): void {
  const url = new URL(request.url);
  const unsupported = [...url.searchParams.keys()].find(
    (name) => name !== "select" && (!upsert || name !== "on_conflict"),
  );
  if (
    unsupported !== undefined ||
    request.headers.has("Range") ||
    request.headers.has("Range-Unit")
  ) {
    throw new RestError("SLREST103", {
      details: "POST insert accepts only the select query control.",
      hint: upsert
        ? "Use only select and one on_conflict control for POST upsert."
        : "Remove filters, ordering, and pagination from the insert request.",
    });
  }
}

function toAuthorizationPhase(
  result: PromiseSettledResult<ResolvedAuthorization>,
): AuthorizationPhase {
  if (
    result.status === "rejected" &&
    !(
      result.reason instanceof RestError &&
      (result.reason.code === "SLREST302" || result.reason.code === "SLREST303")
    )
  ) {
    throw result.reason;
  }
  return result.status === "fulfilled"
    ? Object.freeze({ resolved: true, authorization: result.value })
    : Object.freeze({ resolved: false, error: result.reason });
}

async function handleInsert(
  request: Request,
  resource: DatabaseResource,
  dependencies: ResourceRouteDependencies,
  id: string,
): Promise<Response> {
  if (!resource.writable) {
    throw new RestError("SLREST204", {
      details: `POST is not available for ${resource.kind} resource ${JSON.stringify(resource.name)}.`,
      headers: { Allow: READ_ONLY_METHODS },
    });
  }

  validateRequestMediaType(request.headers);
  const preferences = parsePreferences(request.headers);
  const onConflict = getOnConflict(request);
  const isUpsert = preferences.resolution !== undefined;
  if (!isUpsert && onConflict !== undefined) {
    throw new RestError("SLREST113", {
      details: "on_conflict requires a conflict resolution preference.",
      hint: "Add resolution=merge-duplicates or resolution=ignore-duplicates.",
    });
  }
  assertInsertControls(request, isUpsert);
  const preferenceApplied = getPreferenceApplied(preferences, "POST");
  const mediaType = negotiateResponseMediaType(request.headers, "resource");
  const query = parseRestQuery(
    request,
    resource,
    dependencies.schema,
    dependencies.queryConfig,
    dependencies.relationships,
  );
  rejectEmbeddedSelection(query);
  const payload = parseInsertPayload(
    await request.text(),
    resource,
    preferences.missing,
  );
  const payloadCount = Array.isArray(payload) ? payload.length : 1;
  if (query.singular && payloadCount !== 1) {
    throw new RestError("SLREST106", {
      details: "A singular insert representation requires exactly one row.",
      hint: "Send one object or request the default JSON array media type.",
    });
  }
  const result = isUpsert
    ? await (async () => {
        const target = resolveConflictTarget(resource, onConflict);
        const [insert, update] = await Promise.allSettled([
          dependencies.authorization.resolve({
            request,
            resource,
            operation: "insert",
          }),
          dependencies.authorization.resolve({
            request,
            resource,
            operation: "update",
          }),
        ]);
        return executeUpsert(
          dependencies.database,
          resource,
          payload,
          query,
          preferences,
          Object.freeze({
            insert: toAuthorizationPhase(insert),
            update: toAuthorizationPhase(update),
          }),
          target,
        );
      })()
    : executeInsert(
        dependencies.database,
        resource,
        payload,
        query,
        preferences,
        await dependencies.authorization.resolve({
          request,
          resource,
          operation: "insert",
        }),
      );
  const response = createMutationResponse({
    result,
    query,
    preferences,
    mediaType,
    preferenceApplied,
    requestId: id,
    status: 201,
  });
  if (preferences.return === "headers-only" && result.location !== null) {
    response.headers.set("Location", result.location);
  }
  return response;
}

function collectPutIdentity(
  filter: RestFilter | undefined,
  resource: DatabaseResource,
): ReadonlyMap<string, RestScalar> {
  const values = new Map<string, RestScalar>();
  const visit = (node: RestFilter): void => {
    if ("and" in node) {
      for (const child of node.and) visit(child);
      return;
    }
    if (!("field" in node) || node.operator !== "eq") {
      throw new RestError("SLREST112", {
        details: "PUT accepts only primary-key equality filters.",
        hint: "Filter every primary-key column exactly once with eq.",
      });
    }
    const column = getPutColumn(resource, node.field);
    const value = node.value;
    if (
      column.primaryKeyPosition === null ||
      Array.isArray(value) ||
      values.has(column.name)
    ) {
      throw new RestError("SLREST112", {
        details: `PUT identity must name each primary-key column exactly once: (${resource.primaryKey.join(", ")}).`,
        hint: "Remove unrelated or duplicate filters.",
      });
    }
    values.set(column.name, value as RestScalar);
  };

  if (filter !== undefined) visit(filter);
  if (
    resource.primaryKey.length === 0 ||
    resource.primaryKey.some((column) => !values.has(column)) ||
    values.size !== resource.primaryKey.length
  ) {
    throw new RestError("SLREST112", {
      details:
        resource.primaryKey.length === 0
          ? `Resource ${JSON.stringify(resource.name)} has no primary key for PUT.`
          : `PUT identity must cover the complete primary key (${resource.primaryKey.join(", ")}).`,
      hint: "Filter every primary-key column exactly once with eq.",
    });
  }
  return values;
}

function getPutColumn(
  resource: DatabaseResource,
  name: string,
): DatabaseColumn {
  const identifier = foldSQLiteIdentifier(name);
  const column = resource.columns.find(
    (candidate) => foldSQLiteIdentifier(candidate.name) === identifier,
  );
  if (column === undefined) {
    throw new RestError("SLREST101", {
      details: `Column ${JSON.stringify(name)} does not exist on resource ${JSON.stringify(resource.name)}.`,
    });
  }
  return column;
}

function blobHex(value: Uint8Array): string {
  return `\\x${[...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function putIdentityMatches(
  column: DatabaseColumn,
  bodyValue: SQLQueryBindings,
  filterValue: RestScalar,
): boolean {
  if (bodyValue === null || filterValue === null) return false;
  if (bodyValue instanceof Uint8Array) {
    return (
      typeof filterValue === "string" && blobHex(bodyValue) === filterValue
    );
  }
  if (typeof filterValue === "boolean") {
    return bodyValue === (filterValue ? 1 : 0);
  }
  if (column.affinity === "integer" || column.affinity === "numeric") {
    return String(bodyValue) === String(filterValue);
  }
  return Object.is(bodyValue, filterValue);
}

function assertPutControls(request: Request, query: RestQuery): void {
  const parameters = new URL(request.url).searchParams;
  if (
    parameters.has("on_conflict") ||
    parameters.has("order") ||
    parameters.has("limit") ||
    parameters.has("offset") ||
    request.headers.has("Range") ||
    request.headers.has("Range-Unit") ||
    query.paginationExplicit ||
    query.order.length > 0
  ) {
    throw new RestError("SLREST112", {
      details:
        "PUT does not accept conflict, ordering, or pagination controls.",
      hint: "Use only select and complete primary-key equality filters.",
    });
  }
}

async function handlePut(
  request: Request,
  resource: DatabaseResource,
  dependencies: ResourceRouteDependencies,
  id: string,
): Promise<Response> {
  if (!resource.writable) {
    throw new RestError("SLREST204", {
      details: `PUT is not available for ${resource.kind} resource ${JSON.stringify(resource.name)}.`,
      headers: { Allow: READ_ONLY_METHODS },
    });
  }
  validateRequestMediaType(request.headers);
  const preferences = parsePreferences(request.headers);
  const preferenceApplied = getPreferenceApplied(preferences, "PUT");
  const mediaType = negotiateResponseMediaType(request.headers, "resource");
  const query = parseRestQuery(
    request,
    resource,
    dependencies.schema,
    dependencies.queryConfig,
    dependencies.relationships,
  );
  rejectEmbeddedSelection(query);
  assertPutControls(request, query);
  const identity = collectPutIdentity(query.filter, resource);
  const payload = parsePutPayload(
    await request.text(),
    resource,
    preferences.missing,
  );
  for (const columnName of resource.primaryKey) {
    const column = getPutColumn(resource, columnName);
    const bodyValue = payload[columnName];
    const filterValue = identity.get(columnName);
    if (
      bodyValue === undefined ||
      filterValue === undefined ||
      !putIdentityMatches(column, bodyValue, filterValue)
    ) {
      throw new RestError("SLREST112", {
        details: `PUT URL and body identities differ for primary-key column ${JSON.stringify(columnName)}.`,
        hint: "Use the same primary-key value in the URL equality filter and body.",
      });
    }
  }

  const [insert, update] = await Promise.allSettled([
    dependencies.authorization.resolve({
      request,
      resource,
      operation: "insert",
    }),
    dependencies.authorization.resolve({
      request,
      resource,
      operation: "update",
      ...(query.filter === undefined ? {} : { clientFilter: query.filter }),
    }),
  ]);
  const result = executeUpsert(
    dependencies.database,
    resource,
    payload,
    query,
    Object.freeze({ ...preferences, resolution: "merge-duplicates" }),
    Object.freeze({
      insert: toAuthorizationPhase(insert),
      update: toAuthorizationPhase(update),
    }),
    resolveConflictTarget(resource),
  );
  const response = createMutationResponse({
    result,
    query,
    preferences,
    mediaType,
    preferenceApplied,
    requestId: id,
    status: 201,
  });
  if (result.location !== null)
    response.headers.set("Location", result.location);
  return response;
}

function assertMutationControls(request: Request): void {
  if (new URL(request.url).searchParams.has("on_conflict")) {
    throw new RestError("SLREST103", {
      details: "on_conflict does not apply to PATCH or DELETE.",
      hint: "Remove on_conflict from the mutation request.",
    });
  }
}

async function handleFilteredMutation(
  request: Request,
  resource: DatabaseResource,
  dependencies: ResourceRouteDependencies,
  id: string,
): Promise<Response> {
  const method = request.method === "PATCH" ? "PATCH" : "DELETE";
  if (!resource.writable) {
    throw new RestError("SLREST204", {
      details: `${method} is not available for ${resource.kind} resource ${JSON.stringify(resource.name)}.`,
      headers: { Allow: READ_ONLY_METHODS },
    });
  }

  assertMutationControls(request);
  if (method === "PATCH") validateRequestMediaType(request.headers);
  const preferences = parsePreferences(request.headers);
  const preferenceApplied = getPreferenceApplied(preferences, method);
  const mediaType = negotiateResponseMediaType(request.headers, "resource");
  const query = parseRestQuery(
    request,
    resource,
    dependencies.schema,
    dependencies.queryConfig,
    dependencies.relationships,
  );
  rejectEmbeddedSelection(query);
  const authorization = await dependencies.authorization.resolve({
    request,
    resource,
    operation: method === "PATCH" ? "update" : "delete",
    ...(query.filter === undefined ? {} : { clientFilter: query.filter }),
  });
  const result =
    method === "PATCH"
      ? executeUpdate(
          dependencies.database,
          resource,
          parseUpdatePatch(await request.text(), resource),
          query,
          preferences,
          authorization,
        )
      : executeDelete(
          dependencies.database,
          resource,
          query,
          preferences,
          authorization,
        );

  return createMutationResponse({
    result,
    query,
    preferences,
    mediaType,
    preferenceApplied,
    requestId: id,
    status: preferences.return === "representation" ? 200 : 204,
  });
}

/** Creates the scalar-read and transactional-mutation resource handler. */
export function createResourceRequestHandler(
  dependencies: ResourceRouteDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      const requestedName = getResourceName(request);
      const resource = resolveResource(dependencies.schema, requestedName);
      if (!resource) {
        throw new RestError("SLREST200", {
          details: `Resource ${JSON.stringify(requestedName)} was not found.`,
        });
      }

      if (request.method === "OPTIONS") {
        const preferences = parsePreferences(request.headers);
        getPreferenceApplied(preferences, "OPTIONS");
        return new Response(null, {
          status: 204,
          headers: { Allow: getOptionsAllow(resource), "X-Request-Id": id },
        });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await handleRead(request, resource, dependencies, id);
      }
      if (request.method === "POST") {
        return await handleInsert(request, resource, dependencies, id);
      }
      if (request.method === "PUT") {
        return await handlePut(request, resource, dependencies, id);
      }
      if (request.method === "PATCH" || request.method === "DELETE") {
        return await handleFilteredMutation(
          request,
          resource,
          dependencies,
          id,
        );
      }

      throw new RestError("SLREST204", {
        details: `Method ${request.method} is not available for resource ${JSON.stringify(resource.name)}.`,
        headers: {
          Allow: resource.writable ? WRITE_METHODS : READ_ONLY_METHODS,
        },
      });
    } catch (error) {
      return toErrorResponse(error, id);
    }
  };
}
