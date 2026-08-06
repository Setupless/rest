import type { RestAuthorizationResolver } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseRelationshipGraph } from "../database/relationships";
import type { DatabaseResource, DatabaseSchema } from "../database/schema";
import { executeRead, type ReadExecutionResult } from "../execution/read";
import { RestError, toErrorResponse } from "../http/errors";
import {
  getResponseContentType,
  negotiateResponseMediaType,
} from "../http/media-type";
import { getPreferenceApplied, parsePreferences } from "../http/preferences";
import {
  parseRestQuery,
  type RestQuery,
  type RestQueryConfig,
} from "../query/query";

export interface ResourceRouteDependencies {
  readonly database: Database;
  readonly schema: DatabaseSchema;
  readonly relationships: DatabaseRelationshipGraph;
  readonly authorization: RestAuthorizationResolver;
  readonly queryConfig: RestQueryConfig;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const READ_ONLY_METHODS = "GET, HEAD, OPTIONS";
const WRITABLE_METHODS = "GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT";

function requestId(request: Request): string {
  const supplied = request.headers.get("X-Request-Id");
  return supplied !== null && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function foldSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
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

function getAllow(resource: DatabaseResource): string {
  return resource.writable ? WRITABLE_METHODS : READ_ONLY_METHODS;
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
  const result = executeRead(
    dependencies.database,
    resource,
    query,
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

/** Creates the complete scalar resource-route request handler. */
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
          headers: { Allow: getAllow(resource), "X-Request-Id": id },
        });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await handleRead(request, resource, dependencies, id);
      }

      throw new RestError("SLREST204", {
        details: `Method ${request.method} is not available for resource ${JSON.stringify(resource.name)}.`,
        headers: { Allow: getAllow(resource) },
      });
    } catch (error) {
      return toErrorResponse(error, id);
    }
  };
}
