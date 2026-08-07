import { SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import { foldSQLiteIdentifier } from "../database/identifier";
import {
  type DatabaseColumn,
  type DatabaseResource,
  hasSQLiteRowid,
} from "../database/schema";
import { RestError } from "../http/errors";
import type { RestPreferences } from "../http/preferences";
import { getFilterColumn } from "../query/filter";
import { compileRestFilter } from "../query/filter-compiler";
import type { RestQuery } from "../query/query";
import { serializeSQLiteValue } from "../serialization/value";
import type { InsertPayload, InsertRow } from "../validation/write-payload";
import { quoteIdentifier } from "./sql";

export interface MutationResult {
  readonly affected: number;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly location: string | null;
}

type StoredIdentity =
  | {
      readonly kind: "rowid";
      readonly column: "rowid" | "_rowid_" | "oid";
      readonly value: bigint;
    }
  | {
      readonly kind: "primary-key";
      readonly values: readonly SQLQueryBindings[];
    };

interface PostImage {
  readonly complete: Readonly<Record<string, unknown>>;
  readonly selected: Readonly<Record<string, unknown>>;
}

type SqlRow = Record<string, unknown>;

function mapDatabaseError(error: unknown, resource: DatabaseResource): never {
  if (!(error instanceof SQLiteError)) throw error;
  const code = error.code ?? "";

  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    throw new RestError("SLREST502", {
      hint: "Retry the request after the indicated delay.",
    });
  }
  if (
    code.startsWith("SQLITE_CONSTRAINT_UNIQUE") ||
    code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    const onlyConstraint =
      resource.uniqueConstraints.length === 1
        ? resource.uniqueConstraints[0]
        : undefined;
    throw new RestError("SLREST400", {
      details:
        onlyConstraint === undefined
          ? `A unique constraint on resource ${JSON.stringify(resource.name)} was violated.`
          : `A unique constraint on (${onlyConstraint.columns.join(", ")}) was violated.`,
      hint: "Use a different key or an applicable resolution preference.",
    });
  }
  if (code.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) {
    const onlyForeignKey =
      resource.foreignKeys.length === 1 ? resource.foreignKeys[0] : undefined;
    throw new RestError("SLREST401", {
      details:
        onlyForeignKey === undefined
          ? `A foreign key on resource ${JSON.stringify(resource.name)} was violated.`
          : `The foreign key (${onlyForeignKey.fromColumns.join(", ")}) referencing ${JSON.stringify(onlyForeignKey.referencedResource)} (${onlyForeignKey.referencedColumns.join(", ")}) was violated.`,
      hint: "Provide a key that references an existing row.",
    });
  }
  if (code.startsWith("SQLITE_CONSTRAINT_NOTNULL")) {
    throw new RestError("SLREST402", {
      details: `A NOT NULL constraint on resource ${JSON.stringify(resource.name)} was violated.`,
      hint: "Provide every required column or use missing=default when a SQLite default exists.",
    });
  }
  if (
    code.startsWith("SQLITE_CONSTRAINT") ||
    code.startsWith("SQLITE_MISMATCH")
  ) {
    throw new RestError("SLREST402", {
      details: `A data constraint on resource ${JSON.stringify(resource.name)} was violated.`,
      hint: "Check required values and the table's public data constraints.",
    });
  }
  throw error;
}

function rowsFromPayload(payload: InsertPayload): readonly InsertRow[] {
  return Array.isArray(payload)
    ? payload
    : Object.freeze([payload as InsertRow]);
}

function compileInsertSql(
  resource: DatabaseResource,
  columns: readonly string[],
  returning: string,
): string {
  const target = quoteIdentifier(resource.name);
  const values =
    columns.length === 0
      ? " DEFAULT VALUES"
      : ` (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  return `INSERT INTO ${target}${values}${returning}`;
}

function primaryKeyReturning(resource: DatabaseResource): string {
  if (resource.primaryKey.length === 0) return "";
  const projections = resource.primaryKey.flatMap((name, index) => {
    const value = quoteIdentifier(name);
    return [
      `CASE WHEN typeof(${value}) = 'integer' THEN CAST(${value} AS TEXT) ELSE ${value} END AS ${quoteIdentifier(`__slrest_pk_value_${index}`)}`,
      `typeof(${value}) AS ${quoteIdentifier(`__slrest_pk_type_${index}`)}`,
    ];
  });
  return ` RETURNING ${projections.join(", ")}`;
}

function getRowidColumn(
  resource: DatabaseResource,
): "rowid" | "_rowid_" | "oid" | undefined {
  if (!hasSQLiteRowid(resource)) return undefined;
  const declared = new Set(
    resource.columns.map((column) => foldSQLiteIdentifier(column.name)),
  );
  return (["rowid", "_rowid_", "oid"] as const).find(
    (candidate) => !declared.has(candidate),
  );
}

function insertRow(
  database: Database,
  resource: DatabaseResource,
  row: InsertRow,
): StoredIdentity {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column] ?? null);
  const rowidColumn = getRowidColumn(resource);

  if (rowidColumn !== undefined) {
    const alias = quoteIdentifier("__slrest_inserted_rowid");
    const returned = database
      .query<{ __slrest_inserted_rowid: unknown }, SQLQueryBindings[]>(
        compileInsertSql(
          resource,
          columns,
          ` RETURNING CAST(${quoteIdentifier(rowidColumn)} AS TEXT) AS ${alias}`,
        ),
      )
      .get(...values);
    const rawRowid = returned?.__slrest_inserted_rowid;
    if (typeof rawRowid !== "string" || !/^-?\d+$/.test(rawRowid)) {
      throw new RestError("SLREST406", {
        details: `Resource ${JSON.stringify(resource.name)} did not return a stable rowid identity.`,
        hint: "Use a table with an accessible rowid alias or complete primary key.",
      });
    }
    return Object.freeze({
      kind: "rowid",
      column: rowidColumn,
      value: BigInt(rawRowid),
    });
  }

  if (resource.primaryKey.length === 0) {
    throw new RestError("SLREST406", {
      details: `Resource ${JSON.stringify(resource.name)} has no stable primary-key or rowid identity.`,
      hint: "Add a complete primary key to the table.",
    });
  }

  const returned = database
    .query<SqlRow, SQLQueryBindings[]>(
      compileInsertSql(resource, columns, primaryKeyReturning(resource)),
    )
    .get(...values);
  if (returned === null) {
    throw new RestError("SLREST406", {
      details: `Resource ${JSON.stringify(resource.name)} did not return a stable inserted identity.`,
      hint: "Use a table with a complete primary key.",
    });
  }
  const identityValues = resource.primaryKey.map((_, index) => {
    const value = returned[`__slrest_pk_value_${index}`];
    const storageType = returned[`__slrest_pk_type_${index}`];
    if (value === null || storageType === "null" || value === undefined) {
      throw new RestError("SLREST406", {
        details: `Resource ${JSON.stringify(resource.name)} produced an incomplete primary-key identity.`,
        hint: "Ensure every primary-key column receives a non-null value.",
      });
    }
    return value as SQLQueryBindings;
  });
  return Object.freeze({
    kind: "primary-key",
    values: Object.freeze(identityValues),
  });
}

function compileIdentity(
  resource: DatabaseResource,
  identity: StoredIdentity,
  alias: string,
): { readonly sql: string; readonly parameters: readonly SQLQueryBindings[] } {
  const quotedAlias = quoteIdentifier(alias);
  if (identity.kind === "rowid") {
    return Object.freeze({
      sql: `${quotedAlias}.${quoteIdentifier(identity.column)} = ?`,
      parameters: Object.freeze([identity.value]),
    });
  }
  return Object.freeze({
    sql: resource.primaryKey
      .map((column) => `${quotedAlias}.${quoteIdentifier(column)} IS ?`)
      .join(" AND "),
    parameters: identity.values,
  });
}

function exactProjection(
  column: DatabaseColumn,
  index: number,
  quotedAlias: string,
): readonly string[] {
  const value = `${quotedAlias}.${quoteIdentifier(column.name)}`;
  return [
    `CASE WHEN typeof(${value}) = 'integer' THEN CAST(${value} AS TEXT) ELSE ${value} END AS ${quoteIdentifier(`__slrest_value_${index}`)}`,
    `typeof(${value}) AS ${quoteIdentifier(`__slrest_type_${index}`)}`,
  ];
}

function readPostImage(
  database: Database,
  resource: DatabaseResource,
  identity: StoredIdentity,
  query: RestQuery,
  authorization: ResolvedAuthorization,
): PostImage {
  const alias = "__slrest_inserted";
  const quotedAlias = quoteIdentifier(alias);
  const identityFilter = compileIdentity(resource, identity, alias);
  const check =
    authorization.check === undefined
      ? undefined
      : compileRestFilter(authorization.check, resource, alias);
  const projections = resource.columns.flatMap((column, index) =>
    exactProjection(column, index, quotedAlias),
  );
  projections.push(
    check === undefined
      ? `1 AS ${quoteIdentifier("__slrest_allowed")}`
      : `CASE WHEN ${check.sql} THEN 1 ELSE 0 END AS ${quoteIdentifier("__slrest_allowed")}`,
  );
  const parameters: SQLQueryBindings[] = [
    ...((check?.parameters ?? []) as readonly SQLQueryBindings[]),
    ...identityFilter.parameters,
  ];
  const rawRows = database
    .query<SqlRow, SQLQueryBindings[]>(
      `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(resource.name)} AS ${quotedAlias} WHERE ${identityFilter.sql} LIMIT 2`,
    )
    .all(...parameters);
  const rawRow = rawRows[0];
  if (rawRows.length !== 1 || rawRow === undefined) {
    throw new RestError("SLREST406", {
      details: `The inserted post-image on resource ${JSON.stringify(resource.name)} could not be identified deterministically.`,
      hint: "Use stable primary-key values or a rowid table and avoid identity-changing triggers.",
    });
  }
  if (rawRow.__slrest_allowed !== 1) {
    throw new RestError("SLREST405", {
      details:
        "The inserted post-image did not satisfy the authorization check.",
    });
  }

  const complete: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < resource.columns.length; index += 1) {
    const column = resource.columns[index];
    if (column === undefined) continue;
    const storageType = rawRow[`__slrest_type_${index}`];
    const rawValue = rawRow[`__slrest_value_${index}`];
    const exactValue =
      storageType === "integer" && typeof rawValue === "string"
        ? BigInt(rawValue)
        : rawValue;
    complete[column.name] = serializeSQLiteValue(
      exactValue,
      column,
      resource.name,
      typeof storageType === "string" ? storageType : undefined,
    );
  }
  Object.freeze(complete);

  const selected: Record<string, unknown> = Object.create(null);
  for (const selection of query.selection) {
    if (selection.kind !== "column") {
      throw new RestError("SLREST103", {
        details:
          "Embedded relation selection is not available for insert representations.",
        hint: "Select scalar columns only until relation execution is enabled.",
      });
    }
    const column = getFilterColumn(resource, selection.column);
    if (column === undefined) {
      throw new RestError("SLREST101", {
        details: `Column ${JSON.stringify(selection.column)} does not exist on resource ${JSON.stringify(resource.name)}.`,
      });
    }
    selected[selection.alias ?? selection.column] = complete[column.name];
  }
  return Object.freeze({ complete, selected: Object.freeze(selected) });
}

function locationValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function encodeLocationComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildLocation(
  resource: DatabaseResource,
  postImages: readonly PostImage[],
): string | null {
  const postImage = postImages.length === 1 ? postImages[0] : undefined;
  if (postImage === undefined || resource.primaryKey.length === 0) return null;

  const filters: string[] = [];
  for (const column of resource.primaryKey) {
    const value = locationValue(postImage.complete[column]);
    if (value === undefined) return null;
    filters.push(
      `${encodeLocationComponent(column)}=eq.${encodeLocationComponent(value)}`,
    );
  }
  return `/${encodeLocationComponent(resource.name)}?${filters.join("&")}`;
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
    const identities = rows.map((row) => insertRow(database, resource, row));
    const postImages = identities.map((identity) =>
      readPostImage(database, resource, identity, query, authorization),
    );

    return Object.freeze({
      affected: rows.length,
      rows: Object.freeze(postImages.map((postImage) => postImage.selected)),
      location: buildLocation(resource, postImages),
    });
  });

  try {
    return insert();
  } catch (error) {
    return mapDatabaseError(error, resource);
  }
}
