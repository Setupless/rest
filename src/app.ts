import { Elysia } from "elysia";
import { createAuthorizationResolver } from "./auth/authorize";
import type { RestAuthPlugin } from "./auth/types";
import type { Database } from "./database/database";
import { buildRelationshipGraph } from "./database/relationships";
import type { DatabaseSchema } from "./database/schema";
import { createResourceRequestHandler } from "./routes/resources";

/** Resources required to construct an app without starting a server. */
export interface AppDependencies {
  database: Database;
  schema: DatabaseSchema;
  auth?: RestAuthPlugin;
  maxFilterDepth?: number;
  maxRows?: number;
  maxEmbedDepth?: number;
}

/** Constructs the Elysia application without opening resources or a port. */
export function createRestApp({
  database,
  schema,
  auth,
  maxFilterDepth,
  maxRows = 1000,
  maxEmbedDepth = 5,
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

  return new Elysia()
    .decorate("database", database)
    .decorate("schema", schema)
    .decorate("relationships", relationships)
    .decorate("authorization", authorization)
    .get("/health", () => ({
      status: "ok",
    }))
    .all("/:resource", ({ request }) => handleResource(request))
    .all("/*", ({ request }) => handleResource(request));
}
