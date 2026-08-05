import { Elysia } from "elysia";
import type { Database } from "./database/database";
import type { DatabaseSchema } from "./database/schema";

/** Resources required to construct an app without starting a server. */
export interface AppDependencies {
  database: Database;
  schema: DatabaseSchema;
}

/** Constructs the Elysia application without opening resources or a port. */
export function createRestApp({ database, schema }: AppDependencies) {
  return new Elysia()
    .decorate("database", database)
    .decorate("schema", schema)
    .get("/health", () => ({
      status: "ok",
    }));
}
