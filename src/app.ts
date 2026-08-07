import { Elysia } from "elysia";
import { createAuthorizationResolver } from "./auth/authorize";
import type { RestAuthPlugin } from "./auth/types";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_EMBED_DEPTH,
  DEFAULT_MAX_ROWS,
} from "./config";
import type { Database } from "./database/database";
import { buildRelationshipGraph } from "./database/relationships";
import type { DatabaseSchema } from "./database/schema";
import { createOperationalRequestHandler } from "./http/operations";
import { NOOP_LOGGER, type RestLogger } from "./logging/logger";
import { generateOpenApi, type OpenApiOptions } from "./openapi/generate";
import {
  healthOptionsResponse,
  livenessResponse,
  readinessResponse,
} from "./routes/health";
import { createOpenApiRequestHandler } from "./routes/openapi";
import { createResourceRequestHandler } from "./routes/resources";

const DEFAULT_OPENAPI_INFO = Object.freeze({
  title: "Setupless/rest",
  version: "0.1.0",
});

/** Resources required to construct an app without starting a server. */
export interface AppDependencies {
  database: Database;
  schema: DatabaseSchema;
  auth?: RestAuthPlugin;
  maxFilterDepth?: number;
  maxRows?: number;
  maxEmbedDepth?: number;
  maxBodyBytes?: number;
  corsOrigins?: readonly string[];
  logger?: RestLogger;
  openApi?: Readonly<Pick<OpenApiOptions, "title" | "version">>;
}

/** Constructs the Elysia application without opening resources or a port. */
export function createRestApp({
  database,
  schema,
  auth,
  maxFilterDepth,
  maxRows = DEFAULT_MAX_ROWS,
  maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  corsOrigins = Object.freeze([]),
  logger = NOOP_LOGGER,
  openApi = DEFAULT_OPENAPI_INFO,
}: AppDependencies) {
  const relationships = buildRelationshipGraph(schema);
  const authorization = createAuthorizationResolver(
    auth,
    maxFilterDepth ?? maxEmbedDepth,
  );
  const handleResource = createResourceRequestHandler({
    database,
    schema,
    relationships,
    authorization,
    queryConfig: Object.freeze({ maxRows, maxEmbedDepth }),
  });
  const handleOpenApi = createOpenApiRequestHandler(
    generateOpenApi({
      ...openApi,
      schema,
      relationships,
      authorizationMode: authorization.mode,
      maxRows,
      maxEmbedDepth,
    }),
  );
  const handleOperational = createOperationalRequestHandler(
    { maxBodyBytes, corsOrigins, logger },
    (request, requestId) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/") return handleOpenApi(request, requestId);
      if (pathname === "/health") {
        return request.method === "OPTIONS"
          ? healthOptionsResponse()
          : readinessResponse(request, database);
      }
      if (pathname === "/health/live") {
        return request.method === "OPTIONS"
          ? healthOptionsResponse()
          : livenessResponse(request);
      }
      return handleResource(request, requestId);
    },
  );

  return new Elysia()
    .decorate("database", database)
    .decorate("schema", schema)
    .decorate("relationships", relationships)
    .decorate("authorization", authorization)
    .all("/", ({ request }) => handleOperational(request), {
      parse: "none",
    })
    .all("/health", ({ request }) => handleOperational(request), {
      parse: "none",
    })
    .all("/health/live", ({ request }) => handleOperational(request), {
      parse: "none",
    })
    .all("/:resource", ({ request }) => handleOperational(request), {
      parse: "none",
    })
    .all("/*", ({ request }) => handleOperational(request), {
      parse: "none",
    });
}
