import type { RestAuthorizationMode } from "../auth/types";
import { DEFAULT_MAX_EMBED_DEPTH, DEFAULT_MAX_ROWS } from "../config";
import type {
  DatabaseRelationship,
  DatabaseRelationshipGraph,
} from "../database/relationships";
import type {
  DatabaseColumn,
  DatabaseResource,
  DatabaseSchema,
} from "../database/schema";
import { REST_ERROR_DEFINITIONS, type RestErrorCode } from "../http/errors";
import { createResourceSchemas, type OpenApiObject } from "./schema";

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  readonly schema: DatabaseSchema;
  readonly relationships: DatabaseRelationshipGraph;
  readonly authorizationMode?: RestAuthorizationMode;
  readonly maxRows?: number;
  readonly maxEmbedDepth?: number;
}

interface ResourceComponents {
  readonly row: string;
  readonly insert: string;
  readonly patch: string;
  readonly replace: string;
}

const JSON_CONTENT_TYPE = "application/json";
const SINGULAR_CONTENT_TYPE = "application/vnd.pgrst.object+json";
const RESERVED_QUERY_CONTROLS = new Set([
  "and",
  "limit",
  "offset",
  "on_conflict",
  "or",
  "order",
  "select",
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ref(section: string, name: string): OpenApiObject {
  return { $ref: `#/components/${section}/${name}` };
}

function schemaRef(name: string): OpenApiObject {
  return ref("schemas", name);
}

function responseRef(name: string): OpenApiObject {
  return ref("responses", name);
}

function parameterRef(name: string): OpenApiObject {
  return ref("parameters", name);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function pathForResource(name: string): string {
  return `/${encodeURIComponent(name)}`;
}

function filterParameter(column: DatabaseColumn): OpenApiObject {
  return {
    name: column.name,
    in: "query",
    required: false,
    description:
      "PostgREST-style filter: `operator.value`. Supported operators are " +
      "`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, and `is`; " +
      "prefix with `not.` to negate.",
    schema: { type: "string" },
    "x-sqlite-affinity": column.affinity,
  };
}

function readParameters(resource: DatabaseResource): readonly OpenApiObject[] {
  const parameters: OpenApiObject[] = [
    parameterRef("RequestId"),
    parameterRef("Select"),
    parameterRef("Order"),
    parameterRef("Limit"),
    parameterRef("Offset"),
    parameterRef("Range"),
    parameterRef("RangeUnit"),
    parameterRef("Prefer"),
    parameterRef("And"),
    parameterRef("Or"),
  ];

  for (const column of resource.columns) {
    if (!RESERVED_QUERY_CONTROLS.has(column.name)) {
      parameters.push(filterParameter(column));
    }
  }
  return parameters;
}

function mutationParameters(
  resource: DatabaseResource,
  options: {
    readonly insert?: boolean;
    readonly filtered?: boolean;
    readonly identity?: boolean;
  },
): readonly OpenApiObject[] {
  const parameters: OpenApiObject[] = [
    parameterRef("RequestId"),
    parameterRef("MutationSelect"),
    parameterRef("Prefer"),
  ];
  if (options.insert) parameters.push(parameterRef("OnConflict"));
  if (options.filtered) {
    parameters.push(
      parameterRef("Order"),
      parameterRef("Limit"),
      parameterRef("Offset"),
      parameterRef("Range"),
      parameterRef("RangeUnit"),
      parameterRef("And"),
      parameterRef("Or"),
    );
    for (const column of resource.columns) {
      if (!RESERVED_QUERY_CONTROLS.has(column.name)) {
        parameters.push(filterParameter(column));
      }
    }
  }
  if (options.identity) {
    for (const name of resource.primaryKey) {
      parameters.push({
        name,
        in: "query",
        required: true,
        description:
          "Complete PUT identity filter. Supply exactly once as `eq.value`; the body must contain the same value.",
        schema: { type: "string", pattern: "^eq\\..+$" },
      });
    }
  }
  return parameters;
}

function relationshipMetadata(
  relationships: readonly DatabaseRelationship[],
): readonly OpenApiObject[] {
  return relationships.map((relationship) => ({
    target: relationship.target,
    hint: relationship.hint,
    cardinality: relationship.cardinality,
    kind: relationship.kind,
    syntax: `${relationship.target}!${relationship.hint}(*)`,
    ...(relationship.kind === "many-to-many"
      ? { junction: relationship.junction.resource }
      : {
          columns: relationship.columnMappings.map((mapping) => ({
            source: mapping.source,
            target: mapping.target,
          })),
        }),
  }));
}

function operationSecurity(
  authorizationMode: RestAuthorizationMode,
): OpenApiObject {
  if (authorizationMode === "api-key") {
    return { security: [{ bearerAuth: [] }] };
  }
  if (authorizationMode === "programmatic") {
    return {
      "x-setupless-rest-authorization": {
        mode: "programmatic",
        credentials: "application-defined",
        openapiSecurityAuthoritative: false,
      },
    };
  }
  return { security: [] };
}

function errorResponses(): OpenApiObject {
  return { default: responseRef("Error") };
}

function readResponses(rowComponent: string, head: boolean): OpenApiObject {
  const headers = {
    "Content-Range": ref("headers", "ContentRange"),
    "Range-Unit": ref("headers", "RangeUnit"),
    "X-Request-Id": ref("headers", "RequestId"),
  };
  const content = head
    ? {}
    : {
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: { type: "array", items: schemaRef(rowComponent) },
          },
          [SINGULAR_CONTENT_TYPE]: { schema: schemaRef(rowComponent) },
        },
      };
  const response = {
    description: "Authorized resource representation.",
    headers,
    ...content,
  };
  return {
    200: response,
    206: {
      ...response,
      description: "Authorized partial resource representation.",
    },
    ...errorResponses(),
  };
}

function mutationResponses(
  rowComponent: string,
  status: 200 | 201,
): OpenApiObject {
  return {
    [status]: {
      description:
        "Mutation completed. A representation is present only when requested with Prefer.",
      headers: {
        "Content-Range": ref("headers", "ContentRange"),
        Location: ref("headers", "Location"),
        "Preference-Applied": ref("headers", "PreferenceApplied"),
        "X-Request-Id": ref("headers", "RequestId"),
      },
      content: {
        [JSON_CONTENT_TYPE]: {
          schema: { type: "array", items: schemaRef(rowComponent) },
        },
        [SINGULAR_CONTENT_TYPE]: { schema: schemaRef(rowComponent) },
      },
    },
    204: {
      description: "Mutation completed without a response representation.",
      headers: {
        "Preference-Applied": ref("headers", "PreferenceApplied"),
        "X-Request-Id": ref("headers", "RequestId"),
      },
    },
    ...errorResponses(),
  };
}

function requestBody(
  component: string,
  bulk: boolean,
  description: string,
): OpenApiObject {
  const single = schemaRef(component);
  return {
    required: true,
    description,
    content: {
      [JSON_CONTENT_TYPE]: {
        schema: bulk
          ? {
              oneOf: [single, { type: "array", minItems: 1, items: single }],
            }
          : single,
      },
    },
  };
}

function createResourcePath(
  resource: DatabaseResource,
  components: ResourceComponents,
  relationships: DatabaseRelationshipGraph,
  authorizationMode: RestAuthorizationMode,
): OpenApiObject {
  const relationMetadata = relationshipMetadata(
    relationships.listFrom(resource.name),
  );
  const common = {
    tags: [resource.name],
    ...operationSecurity(authorizationMode),
  };
  const readExtensions = {
    "x-setupless-filter-syntax":
      "column=operator.value; Boolean groups use and=(...) and or=(...).",
    "x-setupless-relation-syntax":
      "select=relation!hint(columns), with nested controls prefixed by the output path.",
    "x-setupless-relationships": relationMetadata,
  };

  const path: Record<string, unknown> = {
    get: {
      ...common,
      summary: `Read ${resource.name}`,
      description:
        "Returns an authorized JSON array by default. Select, filter, relation, order, " +
        "pagination, exact count, item ranges, and singular media controls are supported.",
      parameters: readParameters(resource),
      responses: readResponses(components.row, false),
      ...readExtensions,
      "x-setupless-error-codes": [
        "SLREST100",
        "SLREST101",
        "SLREST102",
        "SLREST103",
        "SLREST104",
        "SLREST105",
        "SLREST106",
        "SLREST109",
        "SLREST110",
        "SLREST200",
        "SLREST202",
        "SLREST203",
        "SLREST300",
        "SLREST301",
        "SLREST302",
        "SLREST303",
        "SLREST304",
        "SLREST500",
        "SLREST501",
        "SLREST502",
        "SLREST503",
        "SLREST504",
      ],
    },
    head: {
      ...common,
      summary: `Inspect ${resource.name}`,
      description:
        "Equivalent to GET but returns response headers without a body.",
      parameters: readParameters(resource),
      responses: readResponses(components.row, true),
      ...readExtensions,
    },
    options: {
      ...common,
      security: [],
      summary: `Inspect methods for ${resource.name}`,
      parameters: [parameterRef("RequestId"), parameterRef("Prefer")],
      responses: {
        204: {
          description: "Supported methods are returned in Allow.",
          headers: {
            Allow: ref("headers", "Allow"),
            "X-Request-Id": ref("headers", "RequestId"),
          },
        },
        ...errorResponses(),
      },
    },
  };

  if (resource.writable) {
    path.post = {
      ...common,
      summary: `Insert or upsert ${resource.name}`,
      parameters: mutationParameters(resource, { insert: true }),
      requestBody: requestBody(
        components.insert,
        true,
        "One object or a non-empty array of objects. Bulk writes are atomic.",
      ),
      responses: mutationResponses(components.row, 201),
      "x-setupless-error-codes": [
        "SLREST101",
        "SLREST103",
        "SLREST104",
        "SLREST105",
        "SLREST106",
        "SLREST107",
        "SLREST113",
        "SLREST206",
        "SLREST300",
        "SLREST301",
        "SLREST302",
        "SLREST303",
        "SLREST304",
        "SLREST400",
        "SLREST401",
        "SLREST402",
        "SLREST403",
        "SLREST405",
        "SLREST406",
        "SLREST500",
        "SLREST501",
        "SLREST502",
        "SLREST503",
        "SLREST504",
      ],
    };
    path.patch = {
      ...common,
      summary: `Update ${resource.name}`,
      parameters: mutationParameters(resource, { filtered: true }),
      requestBody: requestBody(
        components.patch,
        false,
        "A non-empty object containing writable columns to update.",
      ),
      responses: mutationResponses(components.row, 200),
    };
    path.delete = {
      ...common,
      summary: `Delete from ${resource.name}`,
      parameters: mutationParameters(resource, { filtered: true }),
      responses: mutationResponses(components.row, 200),
    };
    path.put = {
      ...common,
      summary: `Replace one ${resource.name} row`,
      description:
        "The URL must filter every primary-key column exactly once with `eq`, and the " +
        "body must carry the same identity.",
      parameters: mutationParameters(resource, { identity: true }),
      requestBody: requestBody(
        components.replace,
        false,
        "Exactly one complete replacement object.",
      ),
      responses: mutationResponses(components.row, 201),
      "x-setupless-primary-key": resource.primaryKey,
    };
  }

  return path;
}

function errorSchemas(): Readonly<Record<string, OpenApiObject>> {
  return Object.fromEntries(
    (
      Object.entries(REST_ERROR_DEFINITIONS) as readonly [
        RestErrorCode,
        (typeof REST_ERROR_DEFINITIONS)[RestErrorCode],
      ][]
    ).map(([code, definition]) => [
      code,
      {
        title: `${code} error`,
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "details", "hint"],
        properties: {
          code: { const: code },
          message: { const: definition.message },
          details: { type: ["string", "null"] },
          hint: { type: ["string", "null"] },
        },
        "x-setupless-http-status": definition.status,
      },
    ]),
  );
}

function errorResponseComponents(): Readonly<Record<string, OpenApiObject>> {
  const entries = Object.entries(REST_ERROR_DEFINITIONS) as readonly [
    RestErrorCode,
    (typeof REST_ERROR_DEFINITIONS)[RestErrorCode],
  ][];
  return Object.fromEntries([
    [
      "Error",
      {
        description: "A controlled Setupless/rest error envelope.",
        headers: { "X-Request-Id": ref("headers", "RequestId") },
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: {
              oneOf: entries.map(([code]) => schemaRef(code)),
            },
          },
        },
      },
    ],
    ...entries.map(([code, definition]) => [
      code,
      {
        description: `${code}: ${definition.message}.`,
        headers: {
          "X-Request-Id": ref("headers", "RequestId"),
          ...(definition.status === 401
            ? { "WWW-Authenticate": ref("headers", "WwwAuthenticate") }
            : {}),
          ...(definition.status === 405
            ? { Allow: ref("headers", "Allow") }
            : {}),
          ...(code === "SLREST502"
            ? { "Retry-After": ref("headers", "RetryAfter") }
            : {}),
        },
        content: {
          [JSON_CONTENT_TYPE]: { schema: schemaRef(code) },
        },
        "x-setupless-http-status": definition.status,
      },
    ]),
  ]);
}

function reusableParameters(): OpenApiObject {
  return {
    RequestId: {
      name: "X-Request-Id",
      in: "header",
      required: false,
      description:
        "A syntactically valid caller request ID is echoed; otherwise one is generated.",
      schema: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
    },
    Select: {
      name: "select",
      in: "query",
      required: false,
      description:
        "Comma-separated columns, `*`, aliases (`alias:column`), or recursive " +
        "relationships (`resource!hint(columns)`).",
      schema: { type: "string", default: "*" },
    },
    MutationSelect: {
      name: "select",
      in: "query",
      required: false,
      description:
        "Comma-separated scalar columns, `*`, or aliases (`alias:column`) for a requested mutation representation. Embedded relations are not supported on mutations.",
      schema: { type: "string", default: "*" },
    },
    Order: {
      name: "order",
      in: "query",
      required: false,
      description:
        "`column[.asc|.desc][.nullsfirst|.nullslast]`, comma-separated.",
      schema: { type: "string" },
    },
    Limit: {
      name: "limit",
      in: "query",
      required: false,
      description: "Maximum rows, bounded by the configured server maximum.",
      schema: { type: "integer", minimum: 0 },
    },
    Offset: {
      name: "offset",
      in: "query",
      required: false,
      description: "Number of authorized rows to skip.",
      schema: { type: "integer", minimum: 0, default: 0 },
    },
    Range: {
      name: "Range",
      in: "header",
      required: false,
      description: "Inclusive item range such as `0-9` or `10-`.",
      schema: { type: "string", pattern: "^[0-9]+-[0-9]*$" },
    },
    RangeUnit: {
      name: "Range-Unit",
      in: "header",
      required: false,
      description: "Only the `items` range unit is supported.",
      schema: { type: "string", enum: ["items"] },
    },
    Prefer: {
      name: "Prefer",
      in: "header",
      required: false,
      description:
        "Comma-separated preferences: `handling`, `return`, `count`, `missing`, " +
        "`resolution`, and `max-affected`, where applicable.",
      schema: { type: "string" },
    },
    OnConflict: {
      name: "on_conflict",
      in: "query",
      required: false,
      description:
        "Comma-separated complete primary or unconditional unique constraint used with a resolution preference.",
      schema: { type: "string" },
    },
    And: {
      name: "and",
      in: "query",
      required: false,
      description:
        "Boolean filter group whose comma-separated members are all required.",
      schema: { type: "string" },
    },
    Or: {
      name: "or",
      in: "query",
      required: false,
      description:
        "Boolean filter group where any comma-separated member may match.",
      schema: { type: "string" },
    },
  };
}

function reusableHeaders(): OpenApiObject {
  return {
    RequestId: {
      description: "Request correlation identifier.",
      schema: { type: "string" },
    },
    ContentRange: {
      description: "Inclusive returned item range and optional exact total.",
      schema: { type: "string" },
    },
    RangeUnit: {
      description: "The range unit used by resource collections.",
      schema: { type: "string", const: "items" },
    },
    PreferenceApplied: {
      description: "Canonical preferences applied to the request.",
      schema: { type: "string" },
    },
    Location: {
      description: "Canonical primary-key resource location when available.",
      schema: { type: "string" },
    },
    Allow: {
      description: "Methods supported by the target resource.",
      schema: { type: "string" },
    },
    WwwAuthenticate: {
      description: "Bearer authentication challenge.",
      schema: { type: "string", const: "Bearer" },
    },
    RetryAfter: {
      description: "Minimum retry delay in seconds for SQLite contention.",
      schema: { type: "integer", const: 1 },
    },
  };
}

function createHealthPath(live: boolean): OpenApiObject {
  const properties: Record<string, OpenApiObject> = {
    status: { type: "string", const: "ok" },
  };
  const required = ["status"];
  if (!live) {
    properties.database = { type: "string", const: "ready" };
    required.push("database");
  }
  const headers = { "X-Request-Id": ref("headers", "RequestId") };
  const parameters = [parameterRef("RequestId"), parameterRef("Prefer")];
  const summary = live ? "Check process liveness" : "Check database readiness";

  return {
    get: {
      tags: ["Operations"],
      summary,
      security: [],
      parameters,
      responses: {
        200: {
          description: live
            ? "The process is serving requests."
            : "The process is serving requests and the database is ready.",
          headers,
          content: {
            [JSON_CONTENT_TYPE]: {
              schema: {
                type: "object",
                additionalProperties: false,
                required,
                properties,
              },
            },
          },
        },
        ...errorResponses(),
      },
    },
    head: {
      tags: ["Operations"],
      summary: `${summary} without a body`,
      security: [],
      parameters,
      responses: {
        200: { description: "Health response headers.", headers },
        ...errorResponses(),
      },
    },
    options: {
      tags: ["Operations"],
      summary: `Inspect ${live ? "liveness" : "readiness"} methods`,
      security: [],
      parameters,
      responses: {
        204: {
          description: "Supported health methods are returned in Allow.",
          headers: {
            Allow: ref("headers", "Allow"),
            ...headers,
          },
        },
        ...errorResponses(),
      },
    },
  };
}

/** Generates one deterministic OpenAPI 3.1 startup-schema document. */
export function generateOpenApi(
  options: OpenApiOptions,
): Readonly<Record<string, unknown>> {
  if (!options.title.trim()) throw new TypeError("title must not be blank");
  if (!options.version.trim()) throw new TypeError("version must not be blank");

  const authorizationMode = options.authorizationMode ?? "none";
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxEmbedDepth = options.maxEmbedDepth ?? DEFAULT_MAX_EMBED_DEPTH;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError("maxRows must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxEmbedDepth) || maxEmbedDepth < 0) {
    throw new TypeError("maxEmbedDepth must be a non-negative safe integer");
  }
  const resources = [...options.schema.listResources()].sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  const reservedComponentNames = new Set([
    "SLRESTError",
    ...Object.keys(REST_ERROR_DEFINITIONS),
  ]);
  const resourceNames = new Set(resources.map((resource) => resource.name));
  const usedComponentNames = new Set(reservedComponentNames);
  const componentNames = new Map<DatabaseResource, ResourceComponents>();
  const resourceSchemas: Record<string, OpenApiObject> = {};

  resources.forEach((resource, index) => {
    const candidatesFor = (base: string) => [
      base,
      `${base}.Insert`,
      `${base}.Patch`,
      `${base}.Replace`,
    ];
    const candidates = candidatesFor(resource.name);
    const canUseResourceName =
      /^[A-Za-z0-9._-]+$/.test(resource.name) &&
      candidates.every(
        (candidate, candidateIndex) =>
          !usedComponentNames.has(candidate) &&
          (candidateIndex === 0 || !resourceNames.has(candidate)),
      );
    let base = resource.name;
    if (!canUseResourceName) {
      let suffix = index + 1;
      do {
        base = `Resource${suffix}`;
        suffix += 1;
      } while (
        candidatesFor(base).some(
          (candidate) =>
            usedComponentNames.has(candidate) || resourceNames.has(candidate),
        )
      );
    }
    const names = {
      row: base,
      insert: `${base}.Insert`,
      patch: `${base}.Patch`,
      replace: `${base}.Replace`,
    };
    for (const name of Object.values(names)) usedComponentNames.add(name);
    componentNames.set(resource, names);
    const schemas = createResourceSchemas(resource);
    resourceSchemas[names.row] = schemas.row;
    resourceSchemas[names.insert] = schemas.insert;
    resourceSchemas[names.patch] = schemas.patch;
    resourceSchemas[names.replace] = schemas.replace;
  });

  const paths: Record<string, OpenApiObject> = {
    "/": {
      get: {
        tags: ["Discovery"],
        summary: "Get the startup OpenAPI document",
        security: [],
        parameters: [parameterRef("RequestId"), parameterRef("Prefer")],
        responses: {
          200: {
            description: "The deterministic OpenAPI 3.1 document.",
            headers: { "X-Request-Id": ref("headers", "RequestId") },
            content: {
              "application/openapi+json": { schema: { type: "object" } },
              [JSON_CONTENT_TYPE]: { schema: { type: "object" } },
            },
          },
          ...errorResponses(),
        },
      },
      head: {
        tags: ["Discovery"],
        summary: "Inspect the startup OpenAPI document",
        security: [],
        parameters: [parameterRef("RequestId"), parameterRef("Prefer")],
        responses: {
          200: {
            description: "OpenAPI response headers without a body.",
            headers: { "X-Request-Id": ref("headers", "RequestId") },
          },
          ...errorResponses(),
        },
      },
      options: {
        tags: ["Discovery"],
        summary: "Inspect API-root methods",
        security: [],
        parameters: [parameterRef("RequestId"), parameterRef("Prefer")],
        responses: {
          204: {
            description: "Supported API-root methods are returned in Allow.",
            headers: {
              Allow: ref("headers", "Allow"),
              "X-Request-Id": ref("headers", "RequestId"),
            },
          },
          ...errorResponses(),
        },
      },
    },
    "/health": createHealthPath(false),
    "/health/live": createHealthPath(true),
  };

  const reservedResourceNames: string[] = [];
  for (const resource of resources) {
    const names = componentNames.get(resource);
    if (names === undefined) throw new Error("Missing resource components");
    const path = pathForResource(resource.name);
    if (Object.hasOwn(paths, path)) {
      reservedResourceNames.push(resource.name);
      continue;
    }
    paths[path] = createResourcePath(
      resource,
      names,
      options.relationships,
      authorizationMode,
    );
  }

  const document = {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: options.title,
      version: options.version,
      description:
        "A deterministic startup snapshot of the Setupless/rest HTTP contract. " +
        "Schema changes require a process restart before this document or routing changes.",
    },
    paths,
    tags: [
      { name: "Discovery", description: "API discovery." },
      { name: "Operations", description: "Process and database operations." },
      ...resources.map((resource) => ({
        name: resource.name,
        description: `${resource.kind} resource ${resource.name}.`,
      })),
    ],
    components: {
      schemas: {
        SLRESTError: {
          title: "Setupless/rest error",
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "details", "hint"],
          properties: {
            code: { type: "string", pattern: "^SLREST[0-9]{3}$" },
            message: { type: "string" },
            details: { type: ["string", "null"] },
            hint: { type: ["string", "null"] },
          },
        },
        ...errorSchemas(),
        ...resourceSchemas,
      },
      responses: errorResponseComponents(),
      parameters: reusableParameters(),
      headers: reusableHeaders(),
      ...(authorizationMode === "api-key"
        ? {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                description:
                  "Stock API-key authentication uses a Bearer token. The configured key is never emitted.",
              },
            },
          }
        : {}),
    },
    "x-setupless-rest-authorization": {
      mode: authorizationMode,
      credentials:
        authorizationMode === "api-key"
          ? "authorization-bearer"
          : authorizationMode === "programmatic"
            ? "application-defined"
            : "none",
      openapiSecurityAuthoritative: authorizationMode !== "programmatic",
      policyBehavior:
        "Programmatic plugins can deny operations and apply validated using (pre-image) and check (post-image) policies independently for each resource operation.",
    },
    "x-setupless-rest": {
      database: "sqlite",
      compatibility: "postgrest-inspired",
      schemaRefresh: "restart-required",
      maxRows,
      maxEmbedDepth,
      reservedResourceNames,
      representation:
        "SQLite storage classes are serialized using the documented lossless Setupless/rest data-representation rules.",
      deviations: [
        {
          id: "sqlite-storage",
          description:
            "SQLite affinity and runtime storage classes replace PostgreSQL's static wire-type system.",
        },
        {
          id: "startup-schema-snapshot",
          description:
            "Resources, relationships, routing, and this document are fixed at startup; schema changes require restart.",
        },
        {
          id: "relation-hints",
          description:
            "Relationship hints use ordered SQLite foreign-key source columns because stable constraint names are unavailable.",
        },
        {
          id: "supported-subset",
          description:
            "Only the filters, preferences, media types, mutations, and relation syntax explicitly documented here are supported.",
        },
      ],
    },
  };

  return deepFreeze(document);
}
