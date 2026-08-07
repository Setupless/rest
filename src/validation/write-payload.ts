import type { SQLQueryBindings } from "bun:sqlite";
import { foldSQLiteIdentifier } from "../database/identifier";
import type { DatabaseColumn, DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";

export type InsertRow = Readonly<Record<string, SQLQueryBindings>>;
export type InsertPayload = InsertRow | readonly InsertRow[];
export type UpdatePatch = Readonly<Record<string, SQLQueryBindings>>;

type JsonNode =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly source: string }
  | { readonly kind: "array"; readonly values: readonly JsonNode[] }
  | {
      readonly kind: "object";
      readonly entries: ReadonlyMap<string, JsonNode>;
    };

interface NormalizedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

const JSON_NUMBER_PATTERN =
  /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const SQLITE_NUMERIC_PREFIX_PATTERN =
  /^[\t\n\v\f\r ]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const SIGNED_64_MIN = -(2n ** 63n);
const SIGNED_64_MAX = 2n ** 63n - 1n;
const MAX_JSON_DEPTH = 128;

function invalidJson(details: string, hint?: string): RestError<"SLREST107"> {
  return new RestError("SLREST107", {
    details,
    hint: hint ?? "Send one JSON object or a non-empty array of JSON objects.",
  });
}

class JsonPayloadParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): JsonNode {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length)
      throw invalidJson("The request body contains malformed JSON.");
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_JSON_DEPTH) {
      throw invalidJson(
        `JSON payload nesting exceeds the supported depth of ${MAX_JSON_DEPTH}.`,
        "Reduce nested JSON objects and arrays.",
      );
    }

    const character = this.source[this.index];
    if (character === '"') {
      return { kind: "string", value: this.parseString() };
    }
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (this.source.startsWith("true", this.index)) {
      this.index += 4;
      return { kind: "boolean", value: true };
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += 5;
      return { kind: "boolean", value: false };
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += 4;
      return { kind: "null" };
    }

    JSON_NUMBER_PATTERN.lastIndex = this.index;
    const number = JSON_NUMBER_PATTERN.exec(this.source)?.[0];
    if (number !== undefined) {
      this.index += number.length;
      return { kind: "number", source: number };
    }
    throw invalidJson("The request body contains malformed JSON.");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;

    while (this.index < this.source.length) {
      const character = this.source[this.index];
      const code = character?.charCodeAt(0) ?? 0;
      if (!escaped && character === '"') {
        this.index += 1;
        try {
          const parsed = JSON.parse(this.source.slice(start, this.index));
          if (typeof parsed === "string") return parsed;
        } catch {
          // Use the stable payload failure below.
        }
        break;
      }
      if (!escaped && (code < 0x20 || character === undefined)) break;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      this.index += 1;
    }
    throw invalidJson("The request body contains a malformed JSON string.");
  }

  private parseObject(depth: number): JsonNode {
    this.index += 1;
    this.skipWhitespace();
    const entries = new Map<string, JsonNode>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return { kind: "object", entries };
    }

    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') {
        throw invalidJson("JSON object keys must be strings.");
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        throw invalidJson("The request body contains a malformed JSON object.");
      }
      this.index += 1;
      this.skipWhitespace();
      if (entries.has(key)) {
        throw invalidJson(
          `JSON object key ${JSON.stringify(key)} is specified more than once.`,
          "Use each key at most once per object.",
        );
      }
      entries.set(key, this.parseValue(depth));
      this.skipWhitespace();

      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return { kind: "object", entries };
      }
      if (delimiter !== ",") {
        throw invalidJson("The request body contains a malformed JSON object.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw invalidJson("The request body contains an unterminated JSON object.");
  }

  private parseArray(depth: number): JsonNode {
    this.index += 1;
    this.skipWhitespace();
    const values: JsonNode[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return { kind: "array", values };
    }

    while (this.index < this.source.length) {
      values.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return { kind: "array", values };
      }
      if (delimiter !== ",") {
        throw invalidJson("The request body contains a malformed JSON array.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw invalidJson("The request body contains an unterminated JSON array.");
  }
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

function parseSafeNumber(source: string): number | undefined {
  const value = Number(source);
  if (!Number.isFinite(value)) return undefined;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;

  const input = normalizeDecimal(source);
  const output = normalizeDecimal(value.toString());
  if (
    input === undefined ||
    output === undefined ||
    input.negative !== output.negative ||
    input.digits !== output.digits ||
    input.exponent !== output.exponent
  ) {
    return undefined;
  }
  return Object.is(value, -0) ? 0 : value;
}

function parseCanonicalInteger(value: string): number | bigint | undefined {
  if (!INTEGER_PATTERN.test(value)) return undefined;
  const integer = BigInt(value);
  if (integer < SIGNED_64_MIN || integer > SIGNED_64_MAX) return undefined;
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
    integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(integer)
    : integer;
}

function invalidValue(
  column: DatabaseColumn,
  expected: string,
  hint: string,
): RestError<"SLREST403"> {
  return new RestError("SLREST403", {
    details: `Column ${JSON.stringify(column.name)} requires ${expected}.`,
    hint,
  });
}

function toJsonValue(node: JsonNode, column: DatabaseColumn): unknown {
  switch (node.kind) {
    case "null":
      return null;
    case "boolean":
    case "string":
      return node.value;
    case "number": {
      const value = parseSafeNumber(node.source);
      if (value === undefined) {
        throw invalidValue(
          column,
          "JSON containing only lossless finite numbers",
          "Represent unsafe integers or exact high-precision decimals as JSON strings.",
        );
      }
      return value;
    }
    case "array":
      return node.values.map((value) => toJsonValue(value, column));
    case "object": {
      const value: Record<string, unknown> = Object.create(null);
      for (const [key, child] of node.entries) {
        Object.defineProperty(value, key, {
          value: toJsonValue(child, column),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return value;
    }
  }
}

function convertValue(
  node: JsonNode,
  column: DatabaseColumn,
): SQLQueryBindings {
  if (node.kind === "null") {
    if (
      column.declaredType.trim().toUpperCase() === "JSON" &&
      !column.nullable
    ) {
      throw invalidValue(
        column,
        "a non-null JSON value",
        "Provide a JSON value other than null.",
      );
    }
    return null;
  }

  const declaredType = column.declaredType.trim().toUpperCase();
  if (declaredType === "BOOLEAN") {
    if (node.kind !== "boolean") {
      throw invalidValue(
        column,
        "a JSON boolean",
        "Send true or false without quotes.",
      );
    }
    return node.value ? 1 : 0;
  }
  if (declaredType === "JSON") {
    return JSON.stringify(toJsonValue(node, column));
  }

  if (column.affinity === "integer") {
    const value =
      node.kind === "number"
        ? parseSafeNumber(node.source)
        : node.kind === "string"
          ? parseCanonicalInteger(node.value)
          : undefined;
    if (
      value === undefined ||
      (typeof value === "number" && !Number.isSafeInteger(value))
    ) {
      throw invalidValue(
        column,
        "a safe integral JSON number or canonical signed 64-bit decimal string",
        "Send large integers as decimal JSON strings.",
      );
    }
    return value;
  }

  if (column.affinity === "real") {
    const value =
      node.kind === "number" ? parseSafeNumber(node.source) : undefined;
    if (value === undefined) {
      throw invalidValue(
        column,
        "a lossless finite JSON number",
        "Use a TEXT-declared column when exact digits outside binary64 are required.",
      );
    }
    return value;
  }

  if (column.affinity === "text") {
    if (node.kind !== "string") {
      throw invalidValue(
        column,
        "a JSON string",
        "Send the value in JSON quotes.",
      );
    }
    return node.value;
  }

  if (column.affinity === "blob") {
    if (
      node.kind !== "string" ||
      !/^\\x(?:[0-9A-Fa-f]{2})*$/.test(node.value)
    ) {
      throw invalidValue(
        column,
        "a \\x-prefixed even-length hexadecimal string",
        "Encode the BLOB as hexadecimal, for example \\x00ff.",
      );
    }
    return Uint8Array.from(
      node.value
        .slice(2)
        .match(/.{2}/g)
        ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    );
  }

  if (node.kind === "number") {
    const value = parseSafeNumber(node.source);
    if (value !== undefined) return value;
  } else if (node.kind === "string") {
    const integer = parseCanonicalInteger(node.value);
    if (integer !== undefined) return integer;
    if (!SQLITE_NUMERIC_PREFIX_PATTERN.test(node.value)) return node.value;
  }
  throw invalidValue(
    column,
    "a lossless number, signed 64-bit decimal string, or retained text",
    "Use a TEXT-declared column for numeric-looking text that SQLite would coerce.",
  );
}

function resolveColumn(
  resource: DatabaseResource,
  name: string,
): DatabaseColumn {
  const identifier = foldSQLiteIdentifier(name);
  const column = resource.columns.find(
    (candidate) => foldSQLiteIdentifier(candidate.name) === identifier,
  );
  if (column === undefined) {
    throw new RestError("SLREST101", {
      details: `Column ${JSON.stringify(name)} does not exist on resource ${JSON.stringify(resource.name)}.`,
    });
  }
  if (!column.writable) {
    throw new RestError("SLREST206", {
      details: `Column ${JSON.stringify(column.name)} on resource ${JSON.stringify(resource.name)} is not writable.`,
      hint: "Remove generated or read-only columns from the payload.",
    });
  }
  return column;
}

function convertRow(
  node: JsonNode,
  resource: DatabaseResource,
  missing: "null" | "default",
  memberIndex?: number,
): InsertRow {
  if (node.kind !== "object") {
    throw invalidJson(
      memberIndex === undefined
        ? "The POST payload must be a JSON object or a non-empty array of objects."
        : `Bulk payload member ${memberIndex} is not a JSON object.`,
    );
  }

  const supplied = new Map<
    string,
    { column: DatabaseColumn; value: JsonNode }
  >();
  for (const [name, value] of node.entries) {
    const column = resolveColumn(resource, name);
    if (supplied.has(column.name)) {
      throw invalidJson(
        `Payload column ${JSON.stringify(column.name)} is specified more than once.`,
        "Use each schema-resolved column at most once per object.",
      );
    }
    supplied.set(column.name, { column, value });
  }

  const row: Record<string, SQLQueryBindings> = Object.create(null);
  for (const column of resource.columns) {
    if (!column.writable) continue;
    const entry = supplied.get(column.name);
    if (entry !== undefined)
      row[column.name] = convertValue(entry.value, column);
    else if (missing === "null") row[column.name] = null;
  }
  return Object.freeze(row);
}

function assertConsistentBulkColumns(rows: readonly InsertRow[]): void {
  const expected = Object.keys(rows[0] ?? {});
  for (let index = 1; index < rows.length; index += 1) {
    const actual = Object.keys(rows[index] ?? {});
    if (
      actual.length !== expected.length ||
      actual.some((column, columnIndex) => column !== expected[columnIndex])
    ) {
      throw invalidJson(
        `Bulk payload member ${index} has a different effective insert column set.`,
        "Use the same columns in every bulk object when missing=default is applied.",
      );
    }
  }
}

/** Parses and losslessly converts one HTTP POST payload before any SQL executes. */
export function parseInsertPayload(
  source: string,
  resource: DatabaseResource,
  missing: "null" | "default",
): InsertPayload {
  let root: JsonNode;
  try {
    root = new JsonPayloadParser(source).parse();
  } catch (error) {
    if (error instanceof RestError) throw error;
    throw invalidJson("The request body contains malformed JSON.");
  }

  if (root.kind === "object") return convertRow(root, resource, missing);
  if (root.kind !== "array") {
    throw invalidJson(
      "The POST payload must be a JSON object or a non-empty array of objects.",
    );
  }
  if (root.values.length === 0) {
    throw invalidJson("A bulk POST payload must contain at least one object.");
  }

  const rows = Object.freeze(
    root.values.map((value, index) =>
      convertRow(value, resource, missing, index),
    ),
  );
  assertConsistentBulkColumns(rows);
  return rows;
}

/** Parses and losslessly converts one non-empty HTTP PATCH object. */
export function parseUpdatePatch(
  source: string,
  resource: DatabaseResource,
): UpdatePatch {
  let root: JsonNode;
  try {
    root = new JsonPayloadParser(source).parse();
  } catch (error) {
    if (error instanceof RestError) throw error;
    throw invalidJson("The request body contains malformed JSON.");
  }

  if (root.kind !== "object") {
    throw invalidJson("The PATCH payload must be exactly one JSON object.");
  }
  if (root.entries.size === 0) {
    throw invalidJson("The PATCH payload must not be empty.");
  }

  const patch: Record<string, SQLQueryBindings> = Object.create(null);
  for (const [name, value] of root.entries) {
    const column = resolveColumn(resource, name);
    if (Object.hasOwn(patch, column.name)) {
      throw invalidJson(
        `Payload column ${JSON.stringify(column.name)} is specified more than once.`,
        "Use each schema-resolved column at most once per object.",
      );
    }
    patch[column.name] = convertValue(value, column);
  }
  return Object.freeze(patch);
}
