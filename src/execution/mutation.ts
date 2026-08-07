import { SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import { foldSQLiteIdentifier } from "../database/identifier";
import { type DatabaseResource, hasSQLiteRowid } from "../database/schema";
import { RestError } from "../http/errors";
import type { RestPreferences } from "../http/preferences";
import { getFilterColumn } from "../query/filter";
import { compileRestFilter } from "../query/filter-compiler";
import type { RestQuery } from "../query/query";
import { serializeSQLiteValue } from "../serialization/value";
import { quoteIdentifier } from "./sql";

export type MutationIdentity =
  | {
      readonly kind: "rowid";
      readonly column: "rowid" | "_rowid_" | "oid";
      readonly value: bigint;
    }
  | {
      readonly kind: "primary-key";
      readonly values: readonly SQLQueryBindings[];
    };

export interface MutationTarget {
  readonly identity: MutationIdentity;
  readonly selected: Readonly<Record<string, unknown>>;
}

type SqlRow = Record<string, unknown>;

const IDENTITY_VALUE_PREFIX = "__slrest_identity_value_";
const IDENTITY_TYPE_PREFIX = "__slrest_identity_type_";
const SELECTED_VALUE_PREFIX = "__slrest_selected_value_";
const SELECTED_TYPE_PREFIX = "__slrest_selected_type_";

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

function exactProjection(
  value: string,
  valueAlias: string,
  typeAlias: string,
): readonly string[] {
  return [
    `CASE WHEN typeof(${value}) = 'integer' THEN CAST(${value} AS TEXT) ELSE ${value} END AS ${quoteIdentifier(valueAlias)}`,
    `typeof(${value}) AS ${quoteIdentifier(typeAlias)}`,
  ];
}

function identityProjections(
  resource: DatabaseResource,
  quotedAlias?: string,
): readonly string[] {
  const prefix = quotedAlias === undefined ? "" : `${quotedAlias}.`;
  const rowidColumn = getRowidColumn(resource);
  if (rowidColumn !== undefined) {
    return Object.freeze([
      `CAST(${prefix}${quoteIdentifier(rowidColumn)} AS TEXT) AS ${quoteIdentifier(`${IDENTITY_VALUE_PREFIX}0`)}`,
      `'integer' AS ${quoteIdentifier(`${IDENTITY_TYPE_PREFIX}0`)}`,
    ]);
  }
  return Object.freeze(
    resource.primaryKey.flatMap((column, index) =>
      exactProjection(
        `${prefix}${quoteIdentifier(column)}`,
        `${IDENTITY_VALUE_PREFIX}${index}`,
        `${IDENTITY_TYPE_PREFIX}${index}`,
      ),
    ),
  );
}

function parseIdentity(
  resource: DatabaseResource,
  row: SqlRow,
): MutationIdentity {
  const rowidColumn = getRowidColumn(resource);
  if (rowidColumn !== undefined) {
    const value = row[`${IDENTITY_VALUE_PREFIX}0`];
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
      throw unstableIdentity(resource);
    }
    return Object.freeze({
      kind: "rowid",
      column: rowidColumn,
      value: BigInt(value),
    });
  }

  if (resource.primaryKey.length === 0) throw unstableIdentity(resource);
  const values = resource.primaryKey.map((_, index) => {
    const value = row[`${IDENTITY_VALUE_PREFIX}${index}`];
    const storageType = row[`${IDENTITY_TYPE_PREFIX}${index}`];
    if (value === null || value === undefined || storageType === "null") {
      throw unstableIdentity(resource);
    }
    return storageType === "integer" && typeof value === "string"
      ? BigInt(value)
      : (value as SQLQueryBindings);
  });
  return Object.freeze({
    kind: "primary-key",
    values: Object.freeze(values),
  });
}

function selectedProjections(
  resource: DatabaseResource,
  query: RestQuery,
  quotedAlias: string,
): readonly string[] {
  return Object.freeze(
    query.selection.flatMap((selection, index) => {
      if (selection.kind !== "column") {
        throw new RestError("SLREST103", {
          details:
            "Embedded relation selection is not available for mutation representations.",
          hint: "Select scalar columns only until relation execution is enabled.",
        });
      }
      const column = getFilterColumn(resource, selection.column);
      if (column === undefined) {
        throw new RestError("SLREST101", {
          details: `Column ${JSON.stringify(selection.column)} does not exist on resource ${JSON.stringify(resource.name)}.`,
        });
      }
      return exactProjection(
        `${quotedAlias}.${quoteIdentifier(column.name)}`,
        `${SELECTED_VALUE_PREFIX}${index}`,
        `${SELECTED_TYPE_PREFIX}${index}`,
      );
    }),
  );
}

function serializeSelectedRow(
  row: SqlRow,
  resource: DatabaseResource,
  query: RestQuery,
): Readonly<Record<string, unknown>> {
  const selected: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < query.selection.length; index += 1) {
    const selection = query.selection[index];
    if (selection?.kind !== "column") {
      throw new TypeError(
        "Embedded mutation selections must be rejected before SQL",
      );
    }
    const column = getFilterColumn(resource, selection.column);
    if (column === undefined) {
      throw new TypeError("Resolved selection metadata is unavailable");
    }
    const storageType = row[`${SELECTED_TYPE_PREFIX}${index}`];
    const rawValue = row[`${SELECTED_VALUE_PREFIX}${index}`];
    const exactValue =
      storageType === "integer" && typeof rawValue === "string"
        ? BigInt(rawValue)
        : rawValue;
    selected[selection.alias ?? selection.column] = serializeSQLiteValue(
      exactValue,
      column,
      resource.name,
      typeof storageType === "string" ? storageType : undefined,
    );
  }
  return Object.freeze(selected);
}

function compileOrder(resourceAlias: string, query: RestQuery): string {
  if (query.order.length === 0) return "";
  const quotedAlias = quoteIdentifier(resourceAlias);
  return ` ORDER BY ${query.order
    .map((term) => {
      const nulls =
        term.nulls === undefined ? "" : ` NULLS ${term.nulls.toUpperCase()}`;
      return `${quotedAlias}.${quoteIdentifier(term.field)} ${term.direction.toUpperCase()}${nulls}`;
    })
    .join(", ")}`;
}

function assertDeterministicPagination(
  resource: DatabaseResource,
  query: RestQuery,
): void {
  if (!query.paginationExplicit) return;
  const orderedColumns = new Set(query.order.map((term) => term.field));
  if (
    resource.uniqueConstraints.some((constraint) =>
      constraint.columns.every((column) => orderedColumns.has(column)),
    )
  ) {
    return;
  }

  const candidates = resource.uniqueConstraints
    .map((constraint) => `(${constraint.columns.join(", ")})`)
    .join(" or ");
  throw new RestError("SLREST207", {
    details:
      candidates.length === 0
        ? `Resource ${JSON.stringify(resource.name)} has no complete unconditional unique constraint for bounded mutation ordering.`
        : `Bounded mutation order must include one complete unique constraint: ${candidates}.`,
    hint: "Add every column from one listed constraint to order, or remove limit, offset, and Range.",
  });
}

/** Selects and snapshots the authorized mutation target set in request order. */
export function selectMutationTargets(
  database: Database,
  resource: DatabaseResource,
  query: RestQuery,
  authorization: ResolvedAuthorization,
  snapshotSelection = true,
): readonly MutationTarget[] {
  assertDeterministicPagination(resource, query);
  const alias = "__slrest_target";
  const quotedAlias = quoteIdentifier(alias);
  const filter =
    authorization.using === undefined
      ? undefined
      : compileRestFilter(authorization.using, resource, alias);
  const where = filter === undefined ? "" : ` WHERE ${filter.sql}`;
  const order = compileOrder(alias, query);
  const pagination = query.paginationExplicit ? " LIMIT ? OFFSET ?" : "";
  const parameters: SQLQueryBindings[] = [
    ...((filter?.parameters ?? []) as readonly SQLQueryBindings[]),
    ...(query.paginationExplicit ? [query.limit, query.offset] : []),
  ];
  const projections = [
    ...identityProjections(resource, quotedAlias),
    ...(snapshotSelection
      ? selectedProjections(resource, query, quotedAlias)
      : []),
  ];
  const rows = database
    .query<SqlRow, SQLQueryBindings[]>(
      `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(resource.name)} AS ${quotedAlias}${where}${order}${pagination}`,
    )
    .all(...parameters);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        identity: parseIdentity(resource, row),
        selected: snapshotSelection
          ? serializeSelectedRow(row, resource, query)
          : Object.freeze({}),
      }),
    ),
  );
}

export function compileIdentity(
  resource: DatabaseResource,
  identity: MutationIdentity,
  alias?: string,
): { readonly sql: string; readonly parameters: readonly SQLQueryBindings[] } {
  const prefix = alias === undefined ? "" : `${quoteIdentifier(alias)}.`;
  if (identity.kind === "rowid") {
    return Object.freeze({
      sql: `${prefix}${quoteIdentifier(identity.column)} = ?`,
      parameters: Object.freeze([identity.value]),
    });
  }
  return Object.freeze({
    sql: resource.primaryKey
      .map((column) => `${prefix}${quoteIdentifier(column)} IS ?`)
      .join(" AND "),
    parameters: identity.values,
  });
}

export function getReturningIdentitySql(resource: DatabaseResource): string {
  return identityProjections(resource).join(", ");
}

export function getReturnedIdentity(
  resource: DatabaseResource,
  row: SqlRow,
): MutationIdentity {
  return parseIdentity(resource, row);
}

/** Re-reads one UPDATE post-image, enforcing its policy check before commit. */
export function readUpdatePostImage(
  database: Database,
  resource: DatabaseResource,
  identity: MutationIdentity,
  query: RestQuery,
  authorization: ResolvedAuthorization,
): Readonly<Record<string, unknown>> {
  const alias = "__slrest_updated";
  const quotedAlias = quoteIdentifier(alias);
  const identityFilter = compileIdentity(resource, identity, alias);
  const check =
    authorization.check === undefined
      ? undefined
      : compileRestFilter(authorization.check, resource, alias);
  const projections = [
    ...selectedProjections(resource, query, quotedAlias),
    check === undefined
      ? `1 AS ${quoteIdentifier("__slrest_allowed")}`
      : `CASE WHEN ${check.sql} THEN 1 ELSE 0 END AS ${quoteIdentifier("__slrest_allowed")}`,
  ];
  const parameters: SQLQueryBindings[] = [
    ...((check?.parameters ?? []) as readonly SQLQueryBindings[]),
    ...identityFilter.parameters,
  ];
  const rows = database
    .query<SqlRow, SQLQueryBindings[]>(
      `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(resource.name)} AS ${quotedAlias} WHERE ${identityFilter.sql} LIMIT 2`,
    )
    .all(...parameters);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw unstableIdentity(resource);
  if (row.__slrest_allowed !== 1) {
    throw new RestError("SLREST405", {
      details:
        "The updated post-image did not satisfy the authorization check.",
    });
  }
  return serializeSelectedRow(row, resource, query);
}

export function assertSingularMutation(
  query: RestQuery,
  affected: number,
): void {
  if (!query.singular || affected === 1) return;
  throw new RestError("SLREST106", {
    details:
      affected === 0
        ? "The authorized mutation targeted zero rows."
        : "The authorized mutation targeted more than one row.",
    hint: "Refine the query so it affects exactly one row.",
  });
}

export function assertMaximumAffected(
  preferences: RestPreferences,
  affected: number,
): void {
  if (
    preferences.maxAffected === undefined ||
    affected <= preferences.maxAffected
  ) {
    return;
  }
  throw new RestError("SLREST111", {
    details: `The mutation affected ${affected} rows, exceeding the requested maximum of ${preferences.maxAffected}.`,
    hint: "Refine the filters or increase max-affected.",
  });
}

function unstableIdentity(resource: DatabaseResource): RestError<"SLREST406"> {
  return new RestError("SLREST406", {
    details: `A mutation post-image on resource ${JSON.stringify(resource.name)} could not be identified deterministically.`,
    hint: "Use stable primary-key values or a rowid table and avoid identity-changing triggers.",
  });
}

/** Maps SQLite mutation failures without exposing SQL, values, or file paths. */
export function mapMutationDatabaseError(
  error: unknown,
  resource: DatabaseResource,
): never {
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
    throw new RestError("SLREST401", {
      details: `A foreign-key constraint involving resource ${JSON.stringify(resource.name)} was violated.`,
      hint: "Preserve referenced rows and provide keys that reference existing rows.",
    });
  }
  if (code.startsWith("SQLITE_CONSTRAINT_NOTNULL")) {
    throw new RestError("SLREST402", {
      details: `A NOT NULL constraint on resource ${JSON.stringify(resource.name)} was violated.`,
      hint: "Provide every required column with a non-null value.",
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
