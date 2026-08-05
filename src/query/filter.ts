import type { DatabaseColumn, DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";

export type RestScalar = string | number | boolean | null;

export type RestComparisonOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "is";

export type RestFilter =
  | {
      readonly field: string;
      readonly operator: RestComparisonOperator;
      readonly value: RestScalar | readonly RestScalar[];
    }
  | { readonly and: readonly RestFilter[] }
  | { readonly or: readonly RestFilter[] }
  | { readonly not: RestFilter };

export interface CompiledSql {
  readonly sql: string;
  readonly parameters: readonly RestScalar[];
}

export const DEFAULT_FILTER_MAX_DEPTH = 5;
export const MAX_FILTER_PARAMETERS = 500;
export const MAX_FILTER_IN_VALUES = MAX_FILTER_PARAMETERS;

const COMPARISON_OPERATORS = new Set<RestComparisonOperator>([
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
const ORDERED_OPERATORS = new Set<RestComparisonOperator>([
  "gt",
  "gte",
  "lt",
  "lte",
]);
const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const SQLITE_NUMERIC_PREFIX_PATTERN =
  /^[\t\n\v\f\r ]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const SIGNED_64_MIN = -(2n ** 63n);
const SIGNED_64_MAX = 2n ** 63n - 1n;

function foldSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

/** @internal Resolves a public field to immutable startup metadata. */
export function getFilterColumn(
  resource: DatabaseResource,
  field: string,
): DatabaseColumn | undefined {
  const identifier = foldSQLiteIdentifier(field);
  return resource.columns.find(
    (column) => foldSQLiteIdentifier(column.name) === identifier,
  );
}

/** @internal Creates a value-safe filter grammar failure. */
export function invalidFilter(details: string): RestError<"SLREST102"> {
  return new RestError("SLREST102", {
    details,
    hint: "Use a supported column, operator, and scalar value.",
  });
}

/** @internal Creates the shared Boolean-depth failure. */
export function filterDepthExceeded(maxDepth: number): RestError<"SLREST110"> {
  return new RestError("SLREST110", {
    details: `Boolean filter nesting exceeds the configured maximum depth of ${maxDepth}.`,
    hint: "Reduce the number of nested and, or, and not groups.",
  });
}

/** @internal Creates the shared unknown-column failure. */
export function unknownColumn(
  resource: DatabaseResource,
  field: string,
): RestError<"SLREST101"> {
  return new RestError("SLREST101", {
    details: `Column ${JSON.stringify(field)} does not exist on resource ${JSON.stringify(resource.name)}.`,
  });
}

/** @internal Enforces the shared SQLite-safe bound for an in value list. */
export function assertFilterInListLength(length: number): void {
  if (length === 0) {
    throw invalidFilter("The in operator requires a non-empty value list.");
  }
  if (length > MAX_FILTER_IN_VALUES) {
    throw invalidFilter(
      `The in operator accepts at most ${MAX_FILTER_IN_VALUES} values.`,
    );
  }
}

interface FilterParameterBudget {
  count: number;
}

function reserveFilterParameters(
  budget: FilterParameterBudget,
  count: number,
): void {
  if (count > MAX_FILTER_PARAMETERS - budget.count) {
    throw invalidFilter(
      `A filter accepts at most ${MAX_FILTER_PARAMETERS} total values.`,
    );
  }
  budget.count += count;
}

function normalizedDeclaredType(column: DatabaseColumn): string {
  return column.declaredType.trim().toUpperCase();
}

function isBooleanColumn(column: DatabaseColumn): boolean {
  return normalizedDeclaredType(column) === "BOOLEAN";
}

function isJsonColumn(column: DatabaseColumn): boolean {
  return normalizedDeclaredType(column) === "JSON";
}

function assertOperatorCompatibility(
  operator: RestComparisonOperator,
  value: RestScalar,
  column: DatabaseColumn,
): void {
  if (operator === "is") {
    if (
      value === null ||
      (typeof value === "boolean" && isBooleanColumn(column))
    ) {
      return;
    }
    throw invalidFilter(
      "The is operator accepts null for any column and true or false only for a declared BOOLEAN column.",
    );
  }

  if (operator === "like" || operator === "ilike") {
    if (column.affinity === "text" && !isJsonColumn(column)) return;
    throw invalidFilter(
      `${operator} is supported only for columns with TEXT affinity.`,
    );
  }

  if (ORDERED_OPERATORS.has(operator)) {
    if (
      !isBooleanColumn(column) &&
      !isJsonColumn(column) &&
      column.affinity !== "blob"
    ) {
      return;
    }
    throw invalidFilter(
      `${operator} is not supported for the declared column representation.`,
    );
  }
}

function parseInteger(value: string): RestScalar | undefined {
  if (!INTEGER_PATTERN.test(value)) return undefined;

  const integer = BigInt(value);
  if (integer < SIGNED_64_MIN || integer > SIGNED_64_MAX) return undefined;
  if (
    integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
    integer <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(integer);
  }

  return value;
}

interface NormalizedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

function normalizeDecimal(value: string): NormalizedDecimal | undefined {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
    value,
  );
  if (!match) return undefined;

  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (!digits) return { negative: false, digits: "0", exponent: 0 };

  let exponent = Number(match[4] ?? "0") - fraction.length;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }

  return { negative: match[1] === "-", digits, exponent };
}

function parseReal(value: string): number | undefined {
  if (!NUMBER_PATTERN.test(value)) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
    return undefined;

  const input = normalizeDecimal(value);
  const roundTripped = normalizeDecimal(parsed.toString());
  if (
    !input ||
    !roundTripped ||
    input.negative !== roundTripped.negative ||
    input.digits !== roundTripped.digits ||
    input.exponent !== roundTripped.exponent
  ) {
    return undefined;
  }

  return parsed;
}

function isBlobValue(value: string): boolean {
  return /^\\x(?:[0-9A-Fa-f]{2})*$/.test(value);
}

function assertProgrammaticValue(
  value: RestScalar,
  column: DatabaseColumn,
): void {
  if (value === null) return;

  if (isBooleanColumn(column)) {
    if (typeof value === "boolean") return;
    throw invalidFilter("Declared BOOLEAN filters require true or false.");
  }

  if (isJsonColumn(column)) {
    if (typeof value === "string") return;
    throw invalidFilter(
      "Declared JSON filters require a serialized scalar value.",
    );
  }

  if (column.affinity === "integer") {
    if (
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && parseInteger(value) !== undefined)
    ) {
      return;
    }
    throw invalidFilter("INTEGER filters require a lossless signed integer.");
  }

  if (column.affinity === "real") {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!Number.isInteger(value) || Number.isSafeInteger(value)) return;
    }
    throw invalidFilter("REAL filters require a lossless finite number.");
  }

  if (column.affinity === "text") {
    if (typeof value === "string") return;
    throw invalidFilter("TEXT filters require a string.");
  }

  if (column.affinity === "blob") {
    if (typeof value === "string" && isBlobValue(value)) return;
    throw invalidFilter(
      "BLOB filters require a \\x-prefixed even-length hex string.",
    );
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isInteger(value) || Number.isSafeInteger(value)) return;
  }
  if (typeof value === "string") {
    if (parseInteger(value) !== undefined) return;
    if (!SQLITE_NUMERIC_PREFIX_PATTERN.test(value)) return;
  }
  throw invalidFilter(
    "NUMERIC filters require a lossless number or retained text.",
  );
}

/** @internal Coerces one URL value through the startup column contract. */
export function coerceFilterValue(
  rawValue: string,
  column: DatabaseColumn,
  operator: RestComparisonOperator,
): RestScalar {
  if (operator === "is") {
    if (rawValue === "null") return null;
    if (rawValue === "true" && isBooleanColumn(column)) return true;
    if (rawValue === "false" && isBooleanColumn(column)) return false;
    throw invalidFilter(
      'The is operator accepts only "null", "true", or "false" for an applicable column.',
    );
  }

  let value: RestScalar;
  if (isBooleanColumn(column)) {
    if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else throw invalidFilter("Declared BOOLEAN filters require true or false.");
  } else if (isJsonColumn(column) || column.affinity === "text") {
    value = rawValue;
  } else if (column.affinity === "integer") {
    const integer = parseInteger(rawValue);
    if (integer === undefined) {
      throw invalidFilter("INTEGER filters require a lossless signed integer.");
    }
    value = integer;
  } else if (column.affinity === "real") {
    const real = parseReal(rawValue);
    if (real === undefined) {
      throw invalidFilter("REAL filters require a lossless finite number.");
    }
    value = real;
  } else if (column.affinity === "blob") {
    if (!isBlobValue(rawValue)) {
      throw invalidFilter(
        "BLOB filters require a \\x-prefixed even-length hex string.",
      );
    }
    value = rawValue.toLowerCase();
  } else {
    const integer = parseInteger(rawValue);
    const real = integer === undefined ? parseReal(rawValue) : undefined;
    if (integer !== undefined) value = integer;
    else if (real !== undefined) value = real;
    else if (!SQLITE_NUMERIC_PREFIX_PATTERN.test(rawValue)) value = rawValue;
    else {
      throw invalidFilter(
        "NUMERIC filters require a lossless number or retained text.",
      );
    }
  }

  assertOperatorCompatibility(operator, value, column);
  assertProgrammaticValue(value, column);
  return value;
}

function assertScalar(value: unknown): asserts value is RestScalar {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return;
  }
  throw invalidFilter(
    "Filter values must be strings, numbers, booleans, or null.",
  );
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw invalidFilter("A filter node has an invalid shape.");
  }
}

function validateNode(
  value: unknown,
  resource: DatabaseResource,
  maxDepth: number,
  booleanDepth: number,
  active: WeakSet<object>,
  parameterBudget: FilterParameterBudget,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidFilter("A filter node must be an object.");
  }
  if (active.has(value)) throw invalidFilter("Filter nodes cannot be cyclic.");
  active.add(value);

  try {
    const node = value as Record<string, unknown>;
    if ("field" in node || "operator" in node || "value" in node) {
      assertExactKeys(node, ["field", "operator", "value"]);
      if (typeof node.field !== "string" || node.field.length === 0) {
        throw invalidFilter("Filter fields must be non-empty strings.");
      }
      if (
        typeof node.operator !== "string" ||
        !COMPARISON_OPERATORS.has(node.operator as RestComparisonOperator)
      ) {
        throw invalidFilter("The filter comparison operator is not supported.");
      }

      const operator = node.operator as RestComparisonOperator;
      const column = getFilterColumn(resource, node.field);
      if (!column) throw unknownColumn(resource, node.field);

      if (operator === "in") {
        if (!Array.isArray(node.value)) {
          throw invalidFilter("The in operator requires a value list.");
        }
        assertFilterInListLength(node.value.length);
        reserveFilterParameters(parameterBudget, node.value.length);
        for (const item of node.value) {
          assertScalar(item);
          if (item === null) {
            throw invalidFilter("The in operator does not accept null values.");
          }
          assertOperatorCompatibility(operator, item, column);
          assertProgrammaticValue(item, column);
        }
        return;
      }

      if (Array.isArray(node.value)) {
        throw invalidFilter(`${operator} requires one scalar value.`);
      }
      assertScalar(node.value);
      if (node.value === null && operator !== "is") {
        throw invalidFilter("Null filters must use the is operator.");
      }
      reserveFilterParameters(parameterBudget, 1);
      assertOperatorCompatibility(operator, node.value, column);
      assertProgrammaticValue(node.value, column);
      return;
    }

    const booleanKeys = ["and", "or", "not"].filter((key) => key in node);
    if (booleanKeys.length !== 1) {
      throw invalidFilter("A filter node has an invalid Boolean shape.");
    }
    const key = booleanKeys[0];
    if (!key)
      throw invalidFilter("A filter node has an invalid Boolean shape.");
    assertExactKeys(node, [key]);

    const nextDepth = booleanDepth + 1;
    if (nextDepth > maxDepth) throw filterDepthExceeded(maxDepth);

    if (key === "not") {
      validateNode(
        node.not,
        resource,
        maxDepth,
        nextDepth,
        active,
        parameterBudget,
      );
      return;
    }

    const children = node[key];
    if (!Array.isArray(children) || children.length === 0) {
      throw invalidFilter(`${key} requires a non-empty filter list.`);
    }
    for (const child of children) {
      validateNode(
        child,
        resource,
        maxDepth,
        nextDepth,
        active,
        parameterBudget,
      );
    }
  } finally {
    active.delete(value);
  }
}

/** Validates URL- or plugin-created filters against one startup resource. */
export function validateRestFilter(
  filter: RestFilter,
  resource: DatabaseResource,
  maxDepth = DEFAULT_FILTER_MAX_DEPTH,
): void {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative safe integer");
  }
  validateNode(filter, resource, maxDepth, 0, new WeakSet(), { count: 0 });
}

/** Combines independently trusted client and policy filters only through AND. */
export function andFilters(
  ...filters: readonly (RestFilter | undefined)[]
): RestFilter | undefined {
  const present = filters.filter(
    (filter): filter is RestFilter => filter !== undefined,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return Object.freeze({ and: Object.freeze(present) });
}
