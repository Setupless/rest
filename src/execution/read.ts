import { SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import type { ResolvedAuthorization } from "../auth/types";
import type { Database } from "../database/database";
import type { DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";
import type { RestQuery } from "../query/query";
import { serializeSQLiteValue } from "../serialization/value";
import { compileReadSql } from "./sql";

export interface ReadExecutionResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rangeStart: number;
  readonly rangeEnd: number | null;
  readonly total: number | null;
}

type SqlRow = Record<string, unknown>;

function mapDatabaseError(error: unknown): never {
  if (
    error instanceof SQLiteError &&
    (error.code?.startsWith("SQLITE_BUSY") ||
      error.code?.startsWith("SQLITE_LOCKED"))
  ) {
    throw new RestError("SLREST502", {
      hint: "Retry the request after the indicated delay.",
    });
  }
  throw error;
}

function parseTotal(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new RestError("SLREST504");
  }
  const total = Number(value);
  if (!Number.isSafeInteger(total)) throw new RestError("SLREST504");
  return total;
}

/** Executes a scalar read and optional exact count in one SQLite transaction. */
export function executeRead(
  database: Database,
  resource: DatabaseResource,
  query: RestQuery,
  authorization: ResolvedAuthorization,
): ReadExecutionResult {
  const compiled = compileReadSql(resource, query, authorization);
  const read = database.transaction((): ReadExecutionResult => {
    const rawRows = database
      .query<SqlRow, SQLQueryBindings[]>(compiled.rowsSql)
      .all(...compiled.rowParameters);
    let total: number | null = null;

    if (query.countExact) {
      const countRow = database
        .query<{ __slrest_total: unknown }, SQLQueryBindings[]>(
          compiled.countSql,
        )
        .get(...compiled.filterParameters);
      total = parseTotal(countRow?.__slrest_total);
    }

    if (
      query.pagination === "range" &&
      total !== null &&
      total > 0 &&
      query.offset >= total
    ) {
      throw new RestError("SLREST109", {
        details: "Range start is beyond the authorized result count.",
        hint: "Use an item range beginning before the returned total.",
        headers: { "Content-Range": `*/${total}` },
      });
    }

    const rows = Object.freeze(
      rawRows.map((rawRow) => {
        const row: Record<string, unknown> = {};
        for (const binding of compiled.columns) {
          const storageType = rawRow[binding.typeAlias];
          const rawValue = rawRow[binding.valueAlias];
          const exactValue =
            storageType === "integer" && typeof rawValue === "string"
              ? BigInt(rawValue)
              : rawValue;
          row[binding.outputName] = serializeSQLiteValue(
            exactValue,
            binding.column,
            resource.name,
            typeof storageType === "string" ? storageType : undefined,
          );
        }
        return Object.freeze(row);
      }),
    );
    const rangeEnd = rows.length === 0 ? null : query.offset + rows.length - 1;

    return Object.freeze({
      rows,
      rangeStart: query.offset,
      rangeEnd,
      total,
    });
  });

  try {
    return read();
  } catch (error) {
    return mapDatabaseError(error);
  }
}
