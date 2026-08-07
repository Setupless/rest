import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseResource } from "../database/schema";
import type { RestPreferences } from "../http/preferences";
import type { RestQuery } from "../query/query";
import type { InsertPayload } from "../validation/write-payload";
import {
  buildMutationLocation,
  insertMutationRow,
  type MutationPostImage,
  mapMutationDatabaseError,
  readMutationPostImage,
  rowsFromInsertPayload,
} from "./mutation";

export interface MutationResult {
  readonly affected: number;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly location: string | null;
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
  const rows = rowsFromInsertPayload(payload);
  const insert = database.transaction((): MutationResult => {
    const postImages: MutationPostImage[] = rows.map((row) =>
      readMutationPostImage(
        database,
        resource,
        insertMutationRow(database, resource, row),
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
