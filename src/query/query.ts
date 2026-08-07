import type { RestConfig } from "../config";
import {
  buildRelationshipGraph,
  type DatabaseRelationshipGraph,
} from "../database/relationships";
import type { DatabaseResource, DatabaseSchema } from "../database/schema";
import { RestError } from "../http/errors";
import { negotiateResponseMediaType } from "../http/media-type";
import { parsePreferences } from "../http/preferences";
import type { RestFilter } from "./filter";
import { parseRestFilters } from "./filter-parser";
import { type OrderTerm, parseRestOrder } from "./order-parser";
import { type PaginationSource, parsePagination } from "./pagination";
import { parseRestSelection, type SelectionPlanNode } from "./select-parser";

export type SelectionNode =
  | {
      readonly kind: "column";
      readonly column: string;
      readonly alias?: string;
    }
  | {
      readonly kind: "relation";
      readonly resource: string;
      readonly alias?: string;
      readonly hint?: string;
      readonly query: RestQuery;
    };

export interface RestQuery {
  readonly selection: readonly SelectionNode[];
  readonly filter?: RestFilter;
  readonly order: readonly OrderTerm[];
  readonly offset: number;
  readonly limit: number;
  /** Retains the source needed to distinguish explicit-range and query offsets. */
  readonly pagination: PaginationSource;
  /** True when limit, offset, or an item Range was explicitly requested. */
  readonly paginationExplicit: boolean;
  readonly countExact: boolean;
  readonly singular: boolean;
}

export type RestQueryConfig = Pick<RestConfig, "maxRows" | "maxEmbedDepth">;

interface SelectionScope {
  readonly path: string;
  readonly resource: DatabaseResource;
  readonly selection: readonly SelectionPlanNode[];
}

export const MAX_QUERY_PARAMETERS = 5000;

const graphCache = new WeakMap<DatabaseSchema, DatabaseRelationshipGraph>();

function invalidQueryControl(details: string): RestError<"SLREST103"> {
  return new RestError("SLREST103", {
    details,
    hint: "Use one select, order, limit, and offset control at each query scope.",
  });
}

function assertQueryEncoding(request: Request): void {
  const queryStart = request.url.indexOf("?");
  if (queryStart < 0) return;
  const fragmentStart = request.url.indexOf("#", queryStart);
  const query = request.url.slice(
    queryStart + 1,
    fragmentStart < 0 ? undefined : fragmentStart,
  );

  try {
    decodeURIComponent(query.replace(/\+/g, " "));
  } catch {
    throw new RestError("SLREST100", {
      details: "The request query contains invalid percent encoding or UTF-8.",
      hint: "Percent-encode query names and values as UTF-8.",
    });
  }
}

function getRelationships(
  schema: DatabaseSchema,
  supplied?: DatabaseRelationshipGraph,
): DatabaseRelationshipGraph {
  if (supplied) return supplied;
  const cached = graphCache.get(schema);
  if (cached) return cached;
  const relationships = buildRelationshipGraph(schema);
  graphCache.set(schema, relationships);
  return relationships;
}

function getOutputName(node: SelectionPlanNode): string {
  return node.alias ?? (node.kind === "column" ? node.column : node.resource);
}

function collectScopes(
  selection: readonly SelectionPlanNode[],
  parentPath: string,
  scopes: Map<string, SelectionScope>,
): void {
  for (const node of selection) {
    if (node.kind !== "relation") continue;
    const outputName = getOutputName(node);
    const path = parentPath ? `${parentPath}.${outputName}` : outputName;
    if (scopes.has(path)) {
      throw invalidQueryControl(
        `Embedded control path ${JSON.stringify(path)} is ambiguous.`,
      );
    }
    scopes.set(path, {
      path,
      resource: node.target,
      selection: node.selection,
    });
    collectScopes(node.selection, path, scopes);
  }
}

function assignScopedParameters(
  searchParams: URLSearchParams,
  scopes: ReadonlyMap<string, SelectionScope>,
): ReadonlyMap<string, URLSearchParams> {
  const parameters = new Map<string, URLSearchParams>([
    ["", new URLSearchParams()],
  ]);
  for (const path of scopes.keys()) parameters.set(path, new URLSearchParams());

  for (const [name, value] of searchParams) {
    let path = "";
    for (
      let dot = name.lastIndexOf(".");
      dot > 0;
      dot = name.lastIndexOf(".", dot - 1)
    ) {
      const candidate = name.slice(0, dot);
      if (scopes.has(candidate)) {
        path = candidate;
        break;
      }
    }
    const target = parameters.get(path);
    if (target === undefined) {
      throw invalidQueryControl(
        `Embedded control path ${JSON.stringify(path)} is unknown.`,
      );
    }
    target.append(path ? name.slice(path.length + 1) : name, value);
  }
  return parameters;
}

function assertSelectionControl(
  parameters: URLSearchParams,
  root: boolean,
): void {
  const values = parameters.getAll("select");
  if (root) {
    if (values.length > 1) {
      throw invalidQueryControl("select must not be repeated.");
    }
  } else if (values.length > 0) {
    throw invalidQueryControl(
      "Embedded select controls are unsupported; declare nested selection inline.",
    );
  }
  if (!root && parameters.has("on_conflict")) {
    throw invalidQueryControl(
      "on_conflict is unsupported for embedded queries.",
    );
  }
}

function buildQuery(
  scope: SelectionScope,
  scopeParameters: ReadonlyMap<string, URLSearchParams>,
  config: RestQueryConfig,
  options: {
    readonly root: boolean;
    readonly headers: Headers;
    readonly strict: boolean;
    readonly countExact: boolean;
    readonly singular: boolean;
  },
): RestQuery {
  const parameters = scopeParameters.get(scope.path) ?? new URLSearchParams();
  assertSelectionControl(parameters, options.root);
  const pagination = parsePagination(parameters, config.maxRows, {
    ...(options.root ? { headers: options.headers } : {}),
    strict: options.root && options.strict,
  });

  const selection = Object.freeze(
    scope.selection.map((node): SelectionNode => {
      if (node.kind === "column") {
        return Object.freeze({
          kind: "column",
          column: node.column,
          ...(node.alias === undefined ? {} : { alias: node.alias }),
        });
      }

      const outputName = getOutputName(node);
      const childPath = scope.path ? `${scope.path}.${outputName}` : outputName;
      const query = buildQuery(
        { path: childPath, resource: node.target, selection: node.selection },
        scopeParameters,
        config,
        {
          ...options,
          root: false,
          countExact: false,
          singular: false,
        },
      );
      return Object.freeze({
        kind: "relation",
        resource: node.resource,
        ...(node.alias === undefined ? {} : { alias: node.alias }),
        ...(node.hint === undefined ? {} : { hint: node.hint }),
        query,
      });
    }),
  );
  const filter = parseRestFilters(
    parameters,
    scope.resource,
    config.maxEmbedDepth,
  );

  return Object.freeze({
    selection,
    ...(filter === undefined ? {} : { filter }),
    order: parseRestOrder(parameters, scope.resource),
    offset: pagination.offset,
    limit: pagination.limit,
    pagination: pagination.source,
    paginationExplicit: pagination.explicit,
    countExact: options.countExact,
    singular: options.singular,
  });
}

/** Parses one request into a schema-resolved, deeply immutable execution plan. */
export function parseRestQuery(
  request: Request,
  resource: DatabaseResource,
  schema: DatabaseSchema,
  config: RestQueryConfig,
  suppliedRelationships: DatabaseRelationshipGraph | undefined = undefined,
): RestQuery {
  if (!Number.isSafeInteger(config.maxRows) || config.maxRows < 1) {
    throw new TypeError("config.maxRows must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.maxEmbedDepth) || config.maxEmbedDepth < 0) {
    throw new TypeError(
      "config.maxEmbedDepth must be a non-negative safe integer",
    );
  }

  assertQueryEncoding(request);
  const url = new URL(request.url);
  if ([...url.searchParams].length > MAX_QUERY_PARAMETERS) {
    throw invalidQueryControl(
      `A query accepts at most ${MAX_QUERY_PARAMETERS} parameters.`,
    );
  }
  const rootSelect = url.searchParams.getAll("select");
  if (rootSelect.length > 1) {
    throw invalidQueryControl("select must not be repeated.");
  }

  const relationships = getRelationships(schema, suppliedRelationships);
  const selection = parseRestSelection(
    rootSelect[0] ?? "*",
    resource,
    schema,
    relationships,
    config.maxEmbedDepth,
  );
  const scopes = new Map<string, SelectionScope>();
  collectScopes(selection, "", scopes);
  const scopeParameters = assignScopedParameters(url.searchParams, scopes);
  const preferences = parsePreferences(request.headers);
  const mediaType = negotiateResponseMediaType(request.headers, "resource");

  return buildQuery(
    { path: "", resource, selection },
    scopeParameters,
    config,
    {
      root: true,
      headers: request.headers,
      strict: preferences.handling === "strict",
      countExact: preferences.count === "exact",
      singular: mediaType.kind === "json-object",
    },
  );
}
