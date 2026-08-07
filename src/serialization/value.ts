import type { DatabaseColumn } from "../database/schema";
import { RestError } from "../http/errors";

const JSON_NUMBER_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

interface NormalizedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

function normalizedDeclaredType(column: DatabaseColumn): string {
  return column.declaredType.trim().toUpperCase();
}

function storedValueError(
  column: DatabaseColumn,
  resourceName?: string,
  representation = "the declared representation",
): RestError<"SLREST501"> {
  const location =
    resourceName === undefined
      ? `Column ${JSON.stringify(column.name)}`
      : `Column ${JSON.stringify(column.name)} on resource ${JSON.stringify(resourceName)}`;
  return new RestError("SLREST501", {
    details: `${location} does not contain valid ${representation}.`,
    hint: "Repair the stored value and retry.",
  });
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

function isSafeJsonNumber(token: string): boolean {
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return false;
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return false;

  const input = normalizeDecimal(token);
  const output = normalizeDecimal(parsed.toString());
  return (
    input !== undefined &&
    output !== undefined &&
    input.negative === output.negative &&
    input.digits === output.digits &&
    input.exponent === output.exponent
  );
}

function assertSafeJsonNumbers(
  source: string,
  column: DatabaseColumn,
  resourceName?: string,
): void {
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) continue;

    const token = JSON_NUMBER_PATTERN.exec(source.slice(index))?.[0];
    if (token === undefined || !isSafeJsonNumber(token)) {
      throw storedValueError(column, resourceName, "declared JSON");
    }
    index += token.length - 1;
  }
}

function serializeInteger(value: bigint): number | string {
  if (
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value.toString();
}

/** Converts one exact SQLite value to its deterministic JSON representation. */
export function serializeSQLiteValue(
  value: unknown,
  column: DatabaseColumn,
  resourceName?: string,
  storageType?: string,
): unknown {
  if (value === null) return null;

  const declaredType = normalizedDeclaredType(column);
  if (declaredType === "BOOLEAN") {
    if (storageType !== undefined && storageType !== "integer") {
      throw storedValueError(column, resourceName, "declared BOOLEAN");
    }
    if (value === 0 || value === 0n) return false;
    if (value === 1 || value === 1n) return true;
    throw storedValueError(column, resourceName, "declared BOOLEAN");
  }

  if (declaredType === "JSON") {
    if (
      typeof value !== "string" ||
      (storageType !== undefined && storageType !== "text")
    ) {
      throw storedValueError(column, resourceName, "declared JSON");
    }
    try {
      assertSafeJsonNumbers(value, column, resourceName);
      return JSON.parse(value);
    } catch (error) {
      if (error instanceof RestError) throw error;
      throw storedValueError(column, resourceName, "declared JSON");
    }
  }

  if (typeof value === "bigint") {
    return serializeInteger(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw storedValueError(column, resourceName, "finite SQLite REAL");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw storedValueError(column, resourceName, "exact SQLite INTEGER");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const byte of value) hex += byte.toString(16).padStart(2, "0");
    return `\\x${hex}`;
  }

  throw storedValueError(column, resourceName);
}
