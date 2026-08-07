import type { SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseResource } from "../database/schema";
import type { RestPreferences } from "../http/preferences";
import type { RestQuery } from "../query/query";
import type { UpdatePatch } from "../validation/write-payload";
import type { MutationResult } from "./insert";
import {
  assertMaximumAffected,
  assertSingularMutation,
  compileIdentity,
  getReturnedIdentity,
  getReturningIdentitySql,
  mapMutationDatabaseError,
  readUpdatePostImage,
  selectMutationTargets,
} from "./mutation";
import { quoteIdentifier } from "./sql";

type SqlRow = Record<string, unknown>;

/** Executes one authorized, filtered PATCH as an atomic SQLite mutation. */
export function executeUpdate(
  database: Database,
  resource: DatabaseResource,
  patch: UpdatePatch,
  query: RestQuery,
  preferences: RestPreferences,
  authorization: ResolvedAuthorization,
): MutationResult {
  const columns = Object.keys(patch);
  if (columns.length === 0) {
    throw new TypeError("executeUpdate requires a validated non-empty patch");
  }
  const assignments = columns
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(", ");
  const values = columns.map((column) => patch[column] ?? null);

  const update = database.transaction((): MutationResult => {
    const targets = selectMutationTargets(
      database,
      resource,
      query,
      authorization,
      false,
    );
    const rows: Readonly<Record<string, unknown>>[] = [];

    for (const target of targets) {
      const identity = compileIdentity(resource, target.identity);
      const returned = database
        .query<SqlRow, SQLQueryBindings[]>(
          `UPDATE ${quoteIdentifier(resource.name)} SET ${assignments} WHERE ${identity.sql} RETURNING ${getReturningIdentitySql(resource)}`,
        )
        .get(...values, ...identity.parameters);
      if (returned === null) continue;
      rows.push(
        readUpdatePostImage(
          database,
          resource,
          getReturnedIdentity(resource, returned),
          query,
          authorization,
        ),
      );
    }

    assertSingularMutation(query, rows.length);
    assertMaximumAffected(preferences, rows.length);
    return Object.freeze({
      affected: rows.length,
      rows: Object.freeze(rows),
      location: null,
    });
  });

  try {
    return update();
  } catch (error) {
    return mapMutationDatabaseError(error, resource);
  }
}
