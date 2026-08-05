/** Side-effect-free public APIs for embedding or starting Setupless/rest. */
export { type AppDependencies, createRestApp } from "./app";
export {
  loadConfig,
  type RestConfig,
  type RestLogLevel,
} from "./config";
export {
  type Database,
  type OpenDatabaseOptions,
  openDatabase,
} from "./database/database";
export {
  type DatabaseColumn,
  type DatabaseResource,
  type DatabaseSchema,
  loadDatabaseSchema,
} from "./database/schema";
export {
  type RunningRestServer,
  type ServeRestOptions,
  serveRest,
} from "./server";
