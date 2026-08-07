import type { SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";
import type { RestPreferences } from "../http/preferences";
import type { RestQuery } from "../query/query";
import type { InsertPayload, InsertRow } from "../validation/write-payload";
import {
  buildMutationLocation,
  getReturnedIdentity,
  getReturningIdentitySql,
  type MutationIdentity,
  type MutationPostImage,
  mapMutationDatabaseError,
  readMutationPostImage,
} from "./mutation";
import { quoteIdentifier } from "./sql";

export interface MutationResult {
  readonly affected: number;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly location: string | null;
}

function rowsFromPayload(payload: InsertPayload): readonly InsertRow[] {
  return Array.isArray(payload)
    ? payload
    : Object.freeze([payload as InsertRow]);
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

/** Executes validated single or bulk inserts and post-image checks atomically. */
export function executeInsert(
  database: Database,
  resource: DatabaseResource,
  payload: InsertPayload,
  query: RestQuery,
  _preferences: RestPreferences,
  authorization: ResolvedAuthorization,
): MutationResult {
  const rows = rowsFromPayload(payload);
  const insert = database.transaction((): MutationResult => {
    const postImages: MutationPostImage[] = rows.map((row) =>
      readMutationPostImage(
        database,
        resource,
        insertRow(database, resource, row),
        query,
        authorization,
        "insert",
      ),
    );

    return Object.freeze({
      affected: rows.length,
      rows: Object.freeze(postImages.map((postImage) => postImage.selected)),
      location: buildMutationLocation(resource, postImages),
    });
  });

  try {
    return insert();
  } catch (error) {
    return mapMutationDatabaseError(error, resource);
  }
}
