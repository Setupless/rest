import type { DatabaseColumn, DatabaseResource } from "../database/schema";
import {
  type CompiledSql,
  DEFAULT_FILTER_MAX_DEPTH,
  getFilterColumn,
  type RestComparisonOperator,
  type RestFilter,
  type RestScalar,
  validateRestFilter,
} from "./filter";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isBlobColumn(column: DatabaseColumn): boolean {
  return (
    column.declaredType.trim().toUpperCase() !== "JSON" &&
    column.affinity === "blob"
  );
}

function parameterExpression(column: DatabaseColumn): string {
  return isBlobColumn(column) ? "unhex(substr(?, 3))" : "?";
}

function compileComparison(
  filter: Extract<RestFilter, { readonly field: string }>,
  resource: DatabaseResource,
  alias: string,
  parameters: RestScalar[],
): string {
  const column = getFilterColumn(resource, filter.field);
  if (!column) {
    throw new TypeError("Validated filter column metadata is unavailable");
  }
  const identifier = `${quoteIdentifier(alias)}.${quoteIdentifier(column.name)}`;
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];

  if (filter.operator === "in") {
    parameters.push(...values);
    return `${identifier} IN (${values
      .map(() => parameterExpression(column))
      .join(", ")})`;
  }

  const value = values[0] ?? null;
  parameters.push(value);
  const operators: Readonly<
    Record<Exclude<RestComparisonOperator, "in">, string>
  > = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    like: "LIKE",
    ilike: "LIKE",
    is: "IS",
  };
  const operator = operators[filter.operator];
  const parameter = parameterExpression(column);
  const collation = filter.operator === "ilike" ? " COLLATE NOCASE" : "";
  if (
    (filter.operator === "like" || filter.operator === "ilike") &&
    typeof parameters[parameters.length - 1] === "string"
  ) {
    parameters[parameters.length - 1] = (
      parameters[parameters.length - 1] as string
    ).replaceAll("*", "%");
  }
  return `${identifier} ${operator} ${parameter}${collation}`;
}

function compileNode(
  filter: RestFilter,
  resource: DatabaseResource,
  alias: string,
  parameters: RestScalar[],
): string {
  if ("field" in filter) {
    return compileComparison(filter, resource, alias, parameters);
  }
  if ("not" in filter) {
    return `NOT (${compileNode(filter.not, resource, alias, parameters)})`;
  }

  const children = "and" in filter ? filter.and : filter.or;
  const operator = "and" in filter ? " AND " : " OR ";
  return children
    .map((child) => `(${compileNode(child, resource, alias, parameters)})`)
    .join(operator);
}

/** Validates and compiles a filter using quoted metadata and bound values only. */
export function compileRestFilter(
  filter: RestFilter,
  resource: DatabaseResource,
  resourceAlias: string,
  maxDepth = DEFAULT_FILTER_MAX_DEPTH,
): CompiledSql {
  validateRestFilter(filter, resource, maxDepth);
  const parameters: RestScalar[] = [];
  const sql = compileNode(filter, resource, resourceAlias, parameters);
  return Object.freeze({ sql, parameters: Object.freeze(parameters) });
}
