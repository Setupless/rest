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
  buildRelationshipGraph,
  type ColumnMapping,
  type DatabaseRelationship,
  type DatabaseRelationshipGraph,
  type DirectRelationship,
  type InverseRelationship,
  type JunctionRelationshipMetadata,
  type ManyToManyRelationship,
  RelationshipResolutionError,
  type RelationshipResolutionErrorCode,
} from "./database/relationships";
export {
  type DatabaseColumn,
  type DatabaseForeignKey,
  type DatabaseResource,
  type DatabaseSchema,
  type DatabaseUniqueConstraint,
  getSQLiteAffinity,
  loadDatabaseSchema,
  type SQLiteAffinity,
} from "./database/schema";
export {
  createRestError,
  REST_ERROR_DEFINITIONS,
  RestError,
  type RestErrorCode,
  type RestErrorOptions,
  toErrorResponse,
} from "./http/errors";
export {
  getResponseContentType,
  negotiateResponseMediaType,
  type RestMediaType,
  validateRequestMediaType,
} from "./http/media-type";
export {
  getPreferenceApplied,
  parsePreferences,
  type RestPreferenceContext,
  type RestPreferenceName,
  type RestPreferences,
} from "./http/preferences";
export {
  type RunningRestServer,
  type ServeRestOptions,
  serveRest,
} from "./server";
