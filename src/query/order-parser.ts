import type { DatabaseResource } from "../database/schema";
import { RestError } from "../http/errors";
import { getFilterColumn, unknownColumn } from "./filter";

export interface OrderTerm {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
}

export const MAX_ORDER_TERMS = 1000;

function invalidOrder(details: string): RestError<"SLREST103"> {
  return new RestError("SLREST103", {
    details,
    hint: "Use order=column[.asc|.desc][.nullsfirst|.nullslast].",
  });
}

/** Parses one schema-validated, deeply immutable order control. */
export function parseRestOrder(
  searchParams: URLSearchParams,
  resource: DatabaseResource,
): readonly OrderTerm[] {
  const values = searchParams.getAll("order");
  if (values.length === 0) return Object.freeze([]);
  if (values.length !== 1) {
    throw invalidOrder("order must not be repeated.");
  }

  const rawTerms = (values[0] ?? "").split(",");
  if (
    rawTerms.length > MAX_ORDER_TERMS ||
    rawTerms.some((term) => term.length === 0 || term.trim() !== term)
  ) {
    throw invalidOrder(
      rawTerms.length > MAX_ORDER_TERMS
        ? `order accepts at most ${MAX_ORDER_TERMS} terms.`
        : "order contains an empty or whitespace-padded term.",
    );
  }

  const fields = new Set<string>();
  const terms = rawTerms.map((rawTerm) => {
    const parts = rawTerm.split(".");
    let nulls: OrderTerm["nulls"];
    let direction: OrderTerm["direction"] = "asc";

    const nullPlacement = parts.at(-1);
    if (nullPlacement === "nullsfirst" || nullPlacement === "nullslast") {
      nulls = nullPlacement === "nullsfirst" ? "first" : "last";
      parts.pop();
    }

    const rawDirection = parts.at(-1);
    if (rawDirection === "asc" || rawDirection === "desc") {
      direction = rawDirection;
      parts.pop();
    }

    const field = parts.join(".");
    if (!field) throw invalidOrder("order contains a term without a column.");

    const column = getFilterColumn(resource, field);
    if (!column) throw unknownColumn(resource, field);
    if (fields.has(column.name)) {
      throw invalidOrder(
        `Column ${JSON.stringify(column.name)} appears more than once in order.`,
      );
    }
    fields.add(column.name);

    return Object.freeze({
      field: column.name,
      direction,
      ...(nulls === undefined ? {} : { nulls }),
    });
  });

  return Object.freeze(terms);
}
