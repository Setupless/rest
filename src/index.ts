/** Side-effect-free public APIs for embedding or starting Setupless/rest. */
export { type AppDependencies, createRestApp } from "./app";
export { createApiKeyAuth } from "./auth/api-key";
export { createAuthorizationResolver } from "./auth/authorize";
export type {
  AuthorizationDecision,
  ResolveAuthorizationOptions,
  ResolvedAuthorization,
  RestAuthorizationContext,
  RestAuthorizationMode,
  RestAuthorizationResolver,
  RestAuthPlugin,
  RestOperation,
} from "./auth/types";
export {
  DEFAULT_MAX_EMBED_DEPTH,
  DEFAULT_MAX_ROWS,
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
export { executeDelete } from "./execution/delete";
export {
  executeInsert,
  type MutationResult,
} from "./execution/insert";
export {
  executeRead,
  type ReadExecutionResult,
} from "./execution/read";
export { executeUpdate } from "./execution/update";
export {
  type AuthorizationPhase,
  type ConflictTarget,
  executeUpsert,
  resolveConflictTarget,
  type UpsertAuthorization,
} from "./execution/upsert";
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
  andFilters,
  type CompiledSql,
  DEFAULT_FILTER_MAX_DEPTH,
  MAX_FILTER_IN_VALUES,
  MAX_FILTER_PARAMETERS,
  type RestComparisonOperator,
  type RestFilter,
  type RestScalar,
  validateRestFilter,
} from "./query/filter";
export { compileRestFilter } from "./query/filter-compiler";
export { parseRestFilters } from "./query/filter-parser";
export type { OrderTerm } from "./query/order-parser";
export type { PaginationSource } from "./query/pagination";
export {
  parseRestQuery,
  type RestQuery,
  type RestQueryConfig,
  type SelectionNode,
} from "./query/query";
export { serializeSQLiteValue } from "./serialization/value";
export {
  type RunningRestServer,
  type ServeRestOptions,
  serveRest,
} from "./server";
export {
  type InsertPayload,
  type InsertRow,
  parseInsertPayload,
  parsePutPayload,
  parseUpdatePatch,
  type UpdatePatch,
} from "./validation/write-payload";
