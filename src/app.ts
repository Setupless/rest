import { Elysia } from "elysia";
import { createAuthorizationResolver } from "./auth/authorize";
import type { RestAuthPlugin } from "./auth/types";
import type { Database } from "./database/database";
import { buildRelationshipGraph } from "./database/relationships";
import type { DatabaseSchema } from "./database/schema";

/** Resources required to construct an app without starting a server. */
export interface AppDependencies {
  database: Database;
  schema: DatabaseSchema;
  auth?: RestAuthPlugin;
  maxFilterDepth?: number;
}

/** Constructs the Elysia application without opening resources or a port. */
export function createRestApp({
  database,
  schema,
  auth,
  maxFilterDepth,
}: AppDependencies) {
  const relationships = buildRelationshipGraph(schema);
  const authorization = createAuthorizationResolver(auth, maxFilterDepth);

  return new Elysia()
    .decorate("database", database)
    .decorate("schema", schema)
    .decorate("relationships", relationships)
    .decorate("authorization", authorization)
    .get("/health", () => ({
      status: "ok",
    }));
}
