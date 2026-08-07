import { RestError } from "../http/errors";

export type PaginationSource = "query" | "range";

export interface ParsedPagination {
  readonly offset: number;
  readonly limit: number;
  readonly source: PaginationSource;
  /** Whether the client explicitly supplied query pagination or an item range. */
  readonly explicit: boolean;
}

const DECIMAL_PATTERN = /^\d+$/;

function invalidQueryControl(control: "limit" | "offset", reason: string) {
  return new RestError("SLREST103", {
    details: `${control} ${reason}.`,
    hint: `${control} must be one non-negative decimal safe integer.`,
  });
}

function invalidRange(reason: string) {
  return new RestError("SLREST109", {
    details: reason,
    hint: "Use Range-Unit: items and an inclusive Range such as 0-9 or 10-.",
  });
}

function parseQueryInteger(
  searchParams: URLSearchParams,
  control: "limit" | "offset",
  fallback: number,
): { readonly present: boolean; readonly value: number } {
  const values = searchParams.getAll(control);
  if (values.length === 0) return { present: false, value: fallback };
  if (values.length !== 1) {
    throw invalidQueryControl(control, "must not be repeated");
  }

  const value = values[0] ?? "";
  if (!DECIMAL_PATTERN.test(value)) {
    throw invalidQueryControl(control, "is malformed");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidQueryControl(control, "exceeds the safe integer range");
  }
  return { present: true, value: parsed };
}

function parseRangeInteger(value: string): number {
  if (!DECIMAL_PATTERN.test(value)) {
    throw invalidRange("Range bounds must be non-negative decimal integers.");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRange("Range bounds must be safe integers.");
  }
  return parsed;
}

function assertMaxRows(maxRows: number): void {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError("maxRows must be a positive safe integer");
  }
}

/** Parses query pagination and optional root HTTP item ranges. */
export function parsePagination(
  searchParams: URLSearchParams,
  maxRows: number,
  options: {
    readonly headers?: Headers;
    readonly strict?: boolean;
  } = {},
): ParsedPagination {
  assertMaxRows(maxRows);

  const range = options.headers?.get("Range") ?? null;
  const rangeUnit = options.headers?.get("Range-Unit") ?? null;

  if (range === null) {
    if (rangeUnit !== null && rangeUnit.toLowerCase() !== "items") {
      throw invalidRange("Only the items range unit is supported.");
    }
    const limit = parseQueryInteger(searchParams, "limit", maxRows);
    const offset = parseQueryInteger(searchParams, "offset", 0);
    return Object.freeze({
      offset: offset.value,
      limit: Math.min(limit.value, maxRows),
      source: "query" as const,
      explicit: limit.present || offset.present,
    });
  }

  if (rangeUnit !== null && rangeUnit.toLowerCase() !== "items") {
    throw invalidRange("Only the items range unit is supported.");
  }
  if (
    options.strict &&
    (searchParams.has("limit") || searchParams.has("offset"))
  ) {
    throw new RestError("SLREST103", {
      details:
        "Range cannot be combined with limit or offset under strict handling.",
      hint: "Remove query pagination, remove Range, or use handling=lenient.",
    });
  }

  const match = /^(\d+)-(\d*)$/.exec(range);
  if (!match) throw invalidRange("Range is malformed.");

  const start = parseRangeInteger(match[1] ?? "");
  const rawEnd = match[2];
  if (rawEnd === undefined) throw invalidRange("Range is malformed.");

  let requestedLimit = maxRows;
  if (rawEnd !== "") {
    const end = parseRangeInteger(rawEnd);
    if (end < start) throw invalidRange("Range end precedes its start.");
    requestedLimit = end - start >= maxRows ? maxRows : end - start + 1;
  }

  return Object.freeze({
    offset: start,
    limit: requestedLimit,
    source: "range" as const,
    explicit: true,
  });
}
