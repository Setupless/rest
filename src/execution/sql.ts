import type { ResolvedAuthorization } from "../auth/types";
import type { DatabaseColumn, DatabaseResource } from "../database/schema";
import type { RestScalar } from "../query/filter";
import { compileRestFilter } from "../query/filter-compiler";
import type { RestQuery } from "../query/query";

export interface ReadColumnBinding {
  readonly column: DatabaseColumn;
  readonly outputName: string;
  readonly valueAlias: string;
  readonly typeAlias: string;
}

export interface CompiledReadSql {
  readonly rowsSql: string;
  readonly countSql: string;
  readonly filterParameters: readonly RestScalar[];
  readonly rowParameters: readonly (RestScalar | number)[];
  readonly columns: readonly ReadColumnBinding[];
}

/** Quotes an identifier that has already been resolved against schema metadata. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function getColumn(resource: DatabaseResource, name: string): DatabaseColumn {
  const column = resource.columns.find((candidate) => candidate.name === name);
  if (!column)
    throw new TypeError("Resolved selection metadata is unavailable");
  return column;
}

/** Builds bound, metadata-only SQL for one scalar read and its optional count. */
export function compileReadSql(
  resource: DatabaseResource,
  query: RestQuery,
  authorization: ResolvedAuthorization,
): CompiledReadSql {
  const resourceAlias = "__slrest_resource";
  const quotedAlias = quoteIdentifier(resourceAlias);
  const columns = Object.freeze(
    query.selection.map((selection, index): ReadColumnBinding => {
      if (selection.kind !== "column") {
        throw new TypeError("Embedded selections must be rejected before SQL");
      }
      return Object.freeze({
        column: getColumn(resource, selection.column),
        outputName: selection.alias ?? selection.column,
        valueAlias: `__slrest_value_${index}`,
        typeAlias: `__slrest_type_${index}`,
      });
    }),
  );
  const projections = columns.flatMap(({ column, valueAlias, typeAlias }) => {
    const value = `${quotedAlias}.${quoteIdentifier(column.name)}`;
    return [
      `CASE WHEN typeof(${value}) = 'integer' THEN CAST(${value} AS TEXT) ELSE ${value} END AS ${quoteIdentifier(valueAlias)}`,
      `typeof(${value}) AS ${quoteIdentifier(typeAlias)}`,
    ];
  });
  const compiledFilter =
    authorization.using === undefined
      ? undefined
      : compileRestFilter(authorization.using, resource, resourceAlias);
  const where =
    compiledFilter === undefined ? "" : ` WHERE ${compiledFilter.sql}`;
  const order =
    query.order.length === 0
      ? ""
      : ` ORDER BY ${query.order
          .map((term) => {
            const nulls =
              term.nulls === undefined
                ? ""
                : ` NULLS ${term.nulls.toUpperCase()}`;
            return `${quotedAlias}.${quoteIdentifier(term.field)} ${term.direction.toUpperCase()}${nulls}`;
          })
          .join(", ")}`;
  const from = `${quoteIdentifier(resource.name)} AS ${quotedAlias}`;
  const filterParameters = compiledFilter?.parameters ?? Object.freeze([]);

  return Object.freeze({
    rowsSql: `SELECT ${projections.join(", ")} FROM ${from}${where}${order} LIMIT ? OFFSET ?`,
    countSql: `SELECT CAST(COUNT(*) AS TEXT) AS ${quoteIdentifier("__slrest_total")} FROM ${from}${where}`,
    filterParameters,
    rowParameters: Object.freeze([
      ...filterParameters,
      query.limit,
      query.offset,
    ]),
    columns,
  });
}
