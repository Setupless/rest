import { Elysia } from "elysia";
import type { Database } from "./database/database";
import { buildRelationshipGraph } from "./database/relationships";
import type { DatabaseSchema } from "./database/schema";

/** Resources required to construct an app without starting a server. */
export interface AppDependencies {
  database: Database;
  schema: DatabaseSchema;
}

/** Constructs the Elysia application without opening resources or a port. */
export function createRestApp({ database, schema }: AppDependencies) {
  const relationships = buildRelationshipGraph(schema);

  return new Elysia()
    .decorate("database", database)
    .decorate("schema", schema)
    .decorate("relationships", relationships)
    .get("/health", () => ({
      status: "ok",
    }));
}
