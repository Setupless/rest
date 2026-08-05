import type { DatabaseColumn, DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";
import {
  andFilters,
  coerceFilterValue,
  DEFAULT_FILTER_MAX_DEPTH,
  filterDepthExceeded,
  getFilterColumn,
  invalidFilter,
  type RestComparisonOperator,
  type RestFilter,
  type RestScalar,
  validateRestFilter,
} from "./filter";

const QUERY_CONTROLS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
]);
const OPERATORS = new Set<RestComparisonOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
]);

function unknownColumn(resource: DatabaseResource, field: string): RestError {
  return new RestError("SLREST101", {
    details: `Column ${JSON.stringify(field)} does not exist on resource ${JSON.stringify(resource.name)}.`,
  });
}

function freezeScalarFilter(
  column: DatabaseColumn,
  operator: RestComparisonOperator,
  value: RestScalar | readonly RestScalar[],
): RestFilter {
  return Object.freeze({
    field: column.name,
    operator,
    value: Array.isArray(value) ? Object.freeze(value) : value,
  }) as RestFilter;
}

function enterBooleanDepth(depth: number, maxDepth: number): number {
  const nextDepth = depth + 1;
  if (nextDepth > maxDepth) throw filterDepthExceeded(maxDepth);
  return nextDepth;
}

function splitGroupItems(value: string): readonly string[] {
  const items: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "(") parentheses += 1;
    else if (character === ")") {
      parentheses -= 1;
      if (parentheses < 0) throw invalidFilter("A Boolean group is malformed.");
    } else if (character === "," && parentheses === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (quoted || escaped || parentheses !== 0) {
    throw invalidFilter("A Boolean group is malformed.");
  }
  items.push(value.slice(start).trim());
  if (items.some((item) => item.length === 0)) {
    throw invalidFilter("Boolean groups cannot contain empty expressions.");
  }
  return Object.freeze(items);
}

function parseInValues(value: string): readonly string[] {
  if (!value.startsWith("(") || !value.endsWith(")")) {
    throw invalidFilter("The in operator requires a parenthesized value list.");
  }

  const source = value.slice(1, -1);
  if (source.trim().length === 0) {
    throw invalidFilter("The in operator requires a non-empty value list.");
  }

  const items: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) {
      throw invalidFilter("The in value list cannot end with a comma.");
    }

    if (source[index] === '"') {
      index += 1;
      let item = "";
      let closed = false;
      while (index < source.length) {
        const character = source[index];
        index += 1;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          const escaped = source[index];
          if (escaped !== '"' && escaped !== "\\") {
            throw invalidFilter(
              'Quoted in values may escape only " and \\ characters.',
            );
          }
          item += escaped;
          index += 1;
        } else {
          item += character;
        }
      }
      if (!closed) throw invalidFilter("A quoted in value is not terminated.");
      while (/\s/.test(source[index] ?? "")) index += 1;
      items.push(item);
    } else {
      const comma = source.indexOf(",", index);
      const end = comma === -1 ? source.length : comma;
      const item = source.slice(index, end).trim();
      if (!item)
        throw invalidFilter("The in value list contains an empty item.");
      items.push(item);
      index = end;
    }

    if (index === source.length) break;
    if (source[index] !== ",") {
      throw invalidFilter("The in value list is malformed.");
    }
    index += 1;
    if (index === source.length) {
      throw invalidFilter("The in value list cannot end with a comma.");
    }
  }

  return Object.freeze(items);
}

function parseComparison(
  field: string,
  expression: string,
  resource: DatabaseResource,
  booleanDepth: number,
  maxDepth: number,
): RestFilter {
  const column = getFilterColumn(resource, field);
  if (!column) throw unknownColumn(resource, field);

  let remainder = expression;
  let negate = false;
  if (remainder.startsWith("not.")) {
    negate = true;
    remainder = remainder.slice(4);
  }

  const separator = remainder.indexOf(".");
  if (separator < 1) {
    throw invalidFilter("A scalar filter must use operator.value syntax.");
  }
  const operator = remainder.slice(0, separator) as RestComparisonOperator;
  if (!OPERATORS.has(operator)) {
    throw invalidFilter("The filter comparison operator is not supported.");
  }
  const rawValue = remainder.slice(separator + 1);
  let value: RestScalar | readonly RestScalar[];
  if (operator === "in") {
    value = Object.freeze(
      parseInValues(rawValue).map((item) =>
        coerceFilterValue(item, column, operator),
      ),
    );
  } else {
    value = coerceFilterValue(rawValue, column, operator);
  }

  const comparison = freezeScalarFilter(column, operator, value);
  if (!negate) return comparison;

  enterBooleanDepth(booleanDepth, maxDepth);
  return Object.freeze({ not: comparison });
}

function unwrapGroup(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    throw invalidFilter("Boolean groups require surrounding parentheses.");
  }
  return trimmed.slice(1, -1);
}

function parseGroup(
  kind: "and" | "or" | "not",
  body: string,
  resource: DatabaseResource,
  booleanDepth: number,
  maxDepth: number,
): RestFilter {
  const nextDepth = enterBooleanDepth(booleanDepth, maxDepth);
  const expressions = splitGroupItems(unwrapGroup(body));

  if (kind === "not") {
    if (expressions.length !== 1) {
      throw invalidFilter("A not group requires exactly one expression.");
    }
    const expression = expressions[0];
    if (!expression) throw invalidFilter("A not group cannot be empty.");
    return Object.freeze({
      not: parseGroupExpression(expression, resource, nextDepth, maxDepth),
    });
  }

  const children = Object.freeze(
    expressions.map((expression) =>
      parseGroupExpression(expression, resource, nextDepth, maxDepth),
    ),
  );
  return kind === "and"
    ? Object.freeze({ and: children })
    : Object.freeze({ or: children });
}

function parseGroupExpression(
  expression: string,
  resource: DatabaseResource,
  booleanDepth: number,
  maxDepth: number,
): RestFilter {
  const group = /^(and|or|not)=?(\(.*\))$/s.exec(expression);
  if (group) {
    return parseGroup(
      group[1] as "and" | "or" | "not",
      group[2] ?? "",
      resource,
      booleanDepth,
      maxDepth,
    );
  }

  const separator = expression.indexOf(".");
  if (separator < 1) {
    throw invalidFilter(
      "A Boolean expression must use column.operator.value syntax.",
    );
  }
  return parseComparison(
    expression.slice(0, separator),
    expression.slice(separator + 1),
    resource,
    booleanDepth,
    maxDepth,
  );
}

/** Parses the supported URL filter subset into one deeply immutable AST. */
export function parseRestFilters(
  searchParams: URLSearchParams,
  resource: DatabaseResource,
  maxDepth = DEFAULT_FILTER_MAX_DEPTH,
): RestFilter | undefined {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative safe integer");
  }

  const filters: RestFilter[] = [];
  for (const [name, value] of searchParams) {
    if (QUERY_CONTROLS.has(name)) continue;
    if (name === "and" || name === "or" || name === "not") {
      filters.push(parseGroup(name, value, resource, 0, maxDepth));
    } else {
      filters.push(parseComparison(name, value, resource, 0, maxDepth));
    }
  }

  const filter = andFilters(...filters);
  if (filter) validateRestFilter(filter, resource, maxDepth);
  return filter;
}
