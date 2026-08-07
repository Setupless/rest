import type { RestAuthorizationResolver } from "../auth/types";
import type { Database } from "../database/database";
import { foldSQLiteIdentifier } from "../database/identifier";
import type { DatabaseRelationshipGraph } from "../database/relationships";
import type { DatabaseResource, DatabaseSchema } from "../database/schema";
import { executeDelete } from "../execution/delete";
import { executeInsert } from "../execution/insert";
import { executeRead, type ReadExecutionResult } from "../execution/read";
import { executeUpdate } from "../execution/update";
import { RestError, toErrorResponse } from "../http/errors";
import {
  getResponseContentType,
  negotiateResponseMediaType,
  validateRequestMediaType,
} from "../http/media-type";
import { getPreferenceApplied, parsePreferences } from "../http/preferences";
import {
  parseRestQuery,
  type RestQuery,
  type RestQueryConfig,
} from "../query/query";
import {
  parseInsertPayload,
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
const WRITE_METHODS = "GET, HEAD, OPTIONS, POST, PATCH, DELETE";

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
  rejectEmbeddedSelection(query);
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
  const result = executeRead(
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

function assertInsertControls(request: Request): void {
  const url = new URL(request.url);
  if (url.searchParams.has("on_conflict")) {
    throw new RestError("SLREST113", {
      details: "Conflict targets are not available for plain inserts.",
      hint: "Remove on_conflict until conflict resolution is enabled.",
    });
  }
  const unsupported = [...url.searchParams.keys()].find(
    (name) => name !== "select",
  );
  if (
    unsupported !== undefined ||
    request.headers.has("Range") ||
    request.headers.has("Range-Unit")
  ) {
    throw new RestError("SLREST103", {
      details: "POST insert accepts only the select query control.",
      hint: "Remove filters, ordering, and pagination from the insert request.",
    });
  }
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

  assertInsertControls(request);
  validateRequestMediaType(request.headers);
  const preferences = parsePreferences(request.headers);
  if (preferences.resolution !== undefined) {
    throw new RestError("SLREST113", {
      details: "Conflict resolution is not available for plain inserts.",
      hint: "Remove the resolution preference until POST upsert is enabled.",
    });
  }
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
  const authorization = await dependencies.authorization.resolve({
    request,
    resource,
    operation: "insert",
  });
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
  const result = executeInsert(
    dependencies.database,
    resource,
    payload,
    query,
    preferences,
    authorization,
  );
  const headers = new Headers({ "X-Request-Id": id });
  if (preferenceApplied !== null) {
    headers.set("Preference-Applied", preferenceApplied);
  }
  if (preferences.count === "exact") {
    headers.set("Range-Unit", "items");
    headers.set(
      "Content-Range",
      result.affected === 0
        ? "*/0"
        : `0-${result.affected - 1}/${result.affected}`,
    );
  }
  if (preferences.return === "headers-only" && result.location !== null) {
    headers.set("Location", result.location);
  }

  let body: string | null = null;
  if (preferences.return === "representation") {
    headers.set("Content-Type", getResponseContentType(mediaType));
    body = jsonBody(query.singular ? result.rows[0] : result.rows);
  }
  return new Response(body, { status: 201, headers });
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

  const headers = new Headers({ "X-Request-Id": id });
  if (preferenceApplied !== null) {
    headers.set("Preference-Applied", preferenceApplied);
  }
  if (preferences.count === "exact") {
    headers.set("Range-Unit", "items");
    headers.set(
      "Content-Range",
      result.affected === 0
        ? "*/0"
        : `0-${result.affected - 1}/${result.affected}`,
    );
  }

  let body: string | null = null;
  if (preferences.return === "representation") {
    headers.set("Content-Type", getResponseContentType(mediaType));
    body = jsonBody(query.singular ? result.rows[0] : result.rows);
  }
  return new Response(body, {
    status: preferences.return === "representation" ? 200 : 204,
    headers,
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
