import type { SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseResource } from "../database/schema";
import type { RestPreferences } from "../http/preferences";
import type { RestQuery } from "../query/query";
import type { MutationResult } from "./insert";
import {
  assertMaximumAffected,
  assertSingularMutation,
  compileIdentity,
  mapMutationDatabaseError,
  selectMutationTargets,
} from "./mutation";
import { quoteIdentifier } from "./sql";

interface DeleteResult {
  readonly __slrest_deleted: number;
}

/** Executes one authorized, filtered DELETE as an atomic SQLite mutation. */
export function executeDelete(
  database: Database,
  resource: DatabaseResource,
  query: RestQuery,
  preferences: RestPreferences,
  authorization: ResolvedAuthorization,
): MutationResult {
  const remove = database.transaction((): MutationResult => {
    const targets = selectMutationTargets(
      database,
      resource,
      query,
      authorization,
    );
    const rows: Readonly<Record<string, unknown>>[] = [];

    for (const target of targets) {
      const identity = compileIdentity(resource, target.identity);
      const returned = database
        .query<DeleteResult, SQLQueryBindings[]>(
          `DELETE FROM ${quoteIdentifier(resource.name)} WHERE ${identity.sql} RETURNING 1 AS ${quoteIdentifier("__slrest_deleted")}`,
        )
        .get(...identity.parameters);
      if (returned?.__slrest_deleted === 1) rows.push(target.selected);
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
    return remove();
  } catch (error) {
    return mapMutationDatabaseError(error, resource);
  }
}
