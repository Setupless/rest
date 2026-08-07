import type { SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import { foldSQLiteIdentifier } from "../database/identifier";
import {
  type DatabaseResource,
  getSQLiteUniqueConstraintCollations,
} from "../database/schema";
import { RestError } from "../http/errors";
import type { RestPreferences } from "../http/preferences";
import { compileRestFilter } from "../query/filter-compiler";
import type { RestQuery } from "../query/query";
import type { InsertPayload, InsertRow } from "../validation/write-payload";
import type { MutationResult } from "./insert";
import {
  assertSingularMutation,
  buildMutationLocation,
  compileIdentity,
  getIdentityProjectionSql,
  getReturnedIdentity,
  getReturningIdentitySql,
  type MutationIdentity,
  type MutationPostImage,
  mapMutationDatabaseError,
  readMutationPostImage,
} from "./mutation";
import { quoteIdentifier } from "./sql";

export interface ConflictTarget {
  readonly columns: readonly string[];
}

export type AuthorizationPhase =
  | {
      readonly resolved: true;
      readonly authorization: ResolvedAuthorization;
    }
  | { readonly resolved: false; readonly error: unknown };

export interface UpsertAuthorization {
  readonly insert: AuthorizationPhase;
  readonly update: AuthorizationPhase;
}

interface ConflictRow extends Record<string, unknown> {
  readonly __slrest_using_allowed: number;
}

const conflictTargetCollations = new WeakMap<
  ConflictTarget,
  readonly string[]
>();

function createConflictTarget(
  columns: readonly string[],
  collations: readonly string[],
): ConflictTarget {
  const target = Object.freeze({ columns });
  conflictTargetCollations.set(target, collations);
  return target;
}

function conflictTargetError(
  resource: DatabaseResource,
  details?: string,
): RestError<"SLREST113"> {
  const candidates = resource.uniqueConstraints
    .map((constraint) => `(${constraint.columns.join(", ")})`)
    .join(" or ");
  return new RestError("SLREST113", {
    details:
      details ??
      (candidates
        ? `Conflict target must exactly match one complete unique constraint: ${candidates}.`
        : `Resource ${JSON.stringify(resource.name)} has no supported conflict target.`),
    hint: "Use the complete primary key or one unconditional column-only unique constraint.",
  });
}

/** Resolves a default or explicit conflict target to canonical schema order. */
export function resolveConflictTarget(
  resource: DatabaseResource,
  onConflict?: string,
): ConflictTarget {
  if (onConflict === undefined) {
    if (resource.primaryKey.length === 0) throw conflictTargetError(resource);
    const primary = resource.uniqueConstraints.find(
      (constraint) => constraint.primary,
    );
    return createConflictTarget(
      resource.primaryKey,
      primary === undefined
        ? Object.freeze(resource.primaryKey.map(() => "BINARY"))
        : getSQLiteUniqueConstraintCollations(primary),
    );
  }

  const requested = onConflict.split(",");
  if (
    requested.length === 0 ||
    requested.some((column) => column.length === 0)
  ) {
    throw conflictTargetError(
      resource,
      "on_conflict contains an empty column name.",
    );
  }
  const columnsByIdentifier = new Map(
    resource.columns.map((column) => [
      foldSQLiteIdentifier(column.name),
      column.name,
    ]),
  );
  const requestedIdentifiers = new Set<string>();
  for (const name of requested) {
    const identifier = foldSQLiteIdentifier(name);
    const column = columnsByIdentifier.get(identifier);
    if (column === undefined) {
      throw new RestError("SLREST101", {
        details: `Column ${JSON.stringify(name)} does not exist on resource ${JSON.stringify(resource.name)}.`,
      });
    }
    if (requestedIdentifiers.has(identifier)) {
      throw conflictTargetError(
        resource,
        `on_conflict names column ${JSON.stringify(column)} more than once.`,
      );
    }
    requestedIdentifiers.add(identifier);
  }

  const constraint = resource.uniqueConstraints.find(
    (candidate) =>
      candidate.columns.length === requestedIdentifiers.size &&
      candidate.columns.every((column) =>
        requestedIdentifiers.has(foldSQLiteIdentifier(column)),
      ),
  );
  if (constraint === undefined) throw conflictTargetError(resource);
  return createConflictTarget(
    constraint.columns,
    getSQLiteUniqueConstraintCollations(constraint),
  );
}

function rowsFromPayload(payload: InsertPayload): readonly InsertRow[] {
  return Array.isArray(payload)
    ? payload
    : Object.freeze([payload as InsertRow]);
}

function requireAuthorization(
  phase: AuthorizationPhase,
): ResolvedAuthorization {
  if (!phase.resolved) throw phase.error;
  return phase.authorization;
}

function compileInsertSql(
  resource: DatabaseResource,
  columns: readonly string[],
): string {
  const values =
    columns.length === 0
      ? " DEFAULT VALUES"
      : ` (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  return `INSERT INTO ${quoteIdentifier(resource.name)}${values} RETURNING ${getReturningIdentitySql(resource)}`;
}

function targetPredicate(
  row: InsertRow,
  target: ConflictTarget,
  resource: DatabaseResource,
  alias: string,
):
  | {
      readonly sql: string;
      readonly parameters: readonly SQLQueryBindings[];
    }
  | undefined {
  const columns = new Map(
    resource.columns.map((column) => [column.name, column]),
  );
  const predicates: string[] = [];
  const parameters: SQLQueryBindings[] = [];
  const quotedAlias = quoteIdentifier(alias);
  const collations = conflictTargetCollations.get(target);

  for (let index = 0; index < target.columns.length; index += 1) {
    const name = target.columns[index];
    if (name === undefined) throw new TypeError("Conflict metadata is invalid");
    const column = columns.get(name);
    if (column === undefined)
      throw new TypeError("Conflict metadata is invalid");
    const targetExpression = `${quotedAlias}.${quoteIdentifier(name)} COLLATE ${quoteIdentifier(collations?.[index] ?? "BINARY")}`;
    const value = row[name];
    if (Object.hasOwn(row, name)) {
      if (value === null || value === undefined) return undefined;
      predicates.push(`${targetExpression} = ?`);
      parameters.push(value);
      continue;
    }
    if (column.defaultValue === null) return undefined;
    predicates.push(`${targetExpression} = (${column.defaultValue})`);
  }

  return Object.freeze({
    sql: predicates.join(" AND "),
    parameters: Object.freeze(parameters),
  });
}

function findConflict(
  database: Database,
  resource: DatabaseResource,
  row: InsertRow,
  target: ConflictTarget,
  updatePhase: AuthorizationPhase,
):
  | { readonly identity: MutationIdentity; readonly usingAllowed: boolean }
  | undefined {
  const alias = "__slrest_conflict";
  const predicate = targetPredicate(row, target, resource, alias);
  if (predicate === undefined) return undefined;
  const updateAuthorization = updatePhase.resolved
    ? updatePhase.authorization
    : undefined;
  const using =
    updateAuthorization?.using === undefined
      ? undefined
      : compileRestFilter(updateAuthorization.using, resource, alias);
  const allowed =
    using === undefined
      ? `1 AS ${quoteIdentifier("__slrest_using_allowed")}`
      : `CASE WHEN ${using.sql} THEN 1 ELSE 0 END AS ${quoteIdentifier("__slrest_using_allowed")}`;
  const parameters: SQLQueryBindings[] = [
    ...((using?.parameters ?? []) as readonly SQLQueryBindings[]),
    ...predicate.parameters,
  ];
  const conflicts = database
    .query<ConflictRow, SQLQueryBindings[]>(
      `SELECT ${getIdentityProjectionSql(resource, alias)}, ${allowed} FROM ${quoteIdentifier(resource.name)} AS ${quoteIdentifier(alias)} WHERE ${predicate.sql} LIMIT 2`,
    )
    .all(...parameters);
  if (conflicts.length === 0) return undefined;
  const conflict = conflicts[0];
  if (conflicts.length !== 1 || conflict === undefined) {
    throw new RestError("SLREST304");
  }
  return Object.freeze({
    identity: getReturnedIdentity(resource, conflict),
    usingAllowed: conflict.__slrest_using_allowed === 1,
  });
}

function insertRow(
  database: Database,
  resource: DatabaseResource,
  row: InsertRow,
): MutationIdentity {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column] ?? null);
  const returned = database
    .query<Record<string, unknown>, SQLQueryBindings[]>(
      compileInsertSql(resource, columns),
    )
    .get(...values);
  if (returned === null) {
    throw new RestError("SLREST406", {
      details: `Resource ${JSON.stringify(resource.name)} did not return a stable inserted identity.`,
      hint: "Use a table with an accessible rowid alias or complete primary key.",
    });
  }
  return getReturnedIdentity(resource, returned);
}

function updateConflict(
  database: Database,
  resource: DatabaseResource,
  row: InsertRow,
  identity: MutationIdentity,
): MutationIdentity {
  const columns = Object.keys(row);
  if (columns.length === 0) return identity;
  const assignments = columns
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(", ");
  const values = columns.map((column) => row[column] ?? null);
  const compiledIdentity = compileIdentity(resource, identity);
  const returned = database
    .query<Record<string, unknown>, SQLQueryBindings[]>(
      `UPDATE ${quoteIdentifier(resource.name)} SET ${assignments} WHERE ${compiledIdentity.sql} RETURNING ${getReturningIdentitySql(resource)}`,
    )
    .get(...values, ...compiledIdentity.parameters);
  if (returned === null) {
    throw new RestError("SLREST406", {
      details: `The conflict row on resource ${JSON.stringify(resource.name)} could not be updated deterministically.`,
      hint: "Avoid identity-changing triggers during an upsert.",
    });
  }
  return getReturnedIdentity(resource, returned);
}

function assertUsingAllowed(
  resource: DatabaseResource,
  allowed: boolean,
): void {
  if (allowed) return;
  throw new RestError("SLREST303", {
    details: `The update operation is forbidden for resource ${JSON.stringify(resource.name)}.`,
  });
}

/** Executes atomic insert, merge, or ignore behavior for validated rows. */
export function executeUpsert(
  database: Database,
  resource: DatabaseResource,
  payload: InsertPayload,
  query: RestQuery,
  preferences: RestPreferences,
  authorization: UpsertAuthorization,
  target: ConflictTarget,
): MutationResult {
  const resolution = preferences.resolution;
  if (resolution === undefined) {
    throw new TypeError("executeUpsert requires a resolution preference");
  }
  const rows = rowsFromPayload(payload);
  const upsert = database.transaction((): MutationResult => {
    const postImages: MutationPostImage[] = [];

    for (const row of rows) {
      const conflict = findConflict(
        database,
        resource,
        row,
        target,
        authorization.update,
      );
      if (conflict === undefined) {
        const insertAuthorization = requireAuthorization(authorization.insert);
        postImages.push(
          readMutationPostImage(
            database,
            resource,
            insertRow(database, resource, row),
            query,
            insertAuthorization,
            "insert",
          ),
        );
        continue;
      }

      if (resolution === "ignore-duplicates") {
        requireAuthorization(authorization.insert);
        continue;
      }
      const updateAuthorization = requireAuthorization(authorization.update);
      assertUsingAllowed(resource, conflict.usingAllowed);
      postImages.push(
        readMutationPostImage(
          database,
          resource,
          updateConflict(database, resource, row, conflict.identity),
          query,
          updateAuthorization,
          "update",
        ),
      );
    }

    assertSingularMutation(query, postImages.length);
    return Object.freeze({
      affected: postImages.length,
      rows: Object.freeze(postImages.map((image) => image.selected)),
      location: buildMutationLocation(resource, postImages),
    });
  });

  try {
    return upsert();
  } catch (error) {
    return mapMutationDatabaseError(error, resource);
  }
}
