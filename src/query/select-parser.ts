import { foldSQLiteIdentifier } from "../database/identifier";
import type { DatabaseRelationshipGraph } from "../database/relationships";
import type { DatabaseResource, DatabaseSchema } from "../database/schema";
import { RestError } from "../http/errors";
import { getFilterColumn, unknownColumn } from "./filter";

export type SelectionPlanNode =
  | {
      readonly kind: "column";
      readonly column: string;
      readonly alias?: string;
    }
  | {
      readonly kind: "relation";
      readonly resource: string;
      readonly alias?: string;
      readonly hint?: string;
      readonly target: DatabaseResource;
      readonly selection: readonly SelectionPlanNode[];
    };

export const MAX_SELECTION_NODES = 5000;
export const MAX_SELECT_LENGTH = 100_000;

interface SelectionBudget {
  count: number;
}

function invalidSelection(details: string): RestError<"SLREST103"> {
  return new RestError("SLREST103", {
    details,
    hint: "Use select=*, comma-separated columns, aliases, or resource!hint(...).",
  });
}

function relationDepthExceeded(maxDepth: number): RestError<"SLREST110"> {
  return new RestError("SLREST110", {
    details: `Relation selection nesting exceeds the configured maximum depth of ${maxDepth}.`,
    hint: "Reduce nested relation selections.",
  });
}

function reserveSelectionNode(budget: SelectionBudget): void {
  budget.count += 1;
  if (budget.count > MAX_SELECTION_NODES) {
    throw invalidSelection(
      `select accepts at most ${MAX_SELECTION_NODES} projected nodes.`,
    );
  }
}

function getResource(
  schema: DatabaseSchema,
  name: string,
): DatabaseResource | undefined {
  const direct = schema.getResource(name);
  if (direct) return direct;
  const identifier = foldSQLiteIdentifier(name);
  return schema
    .listResources()
    .find((resource) => foldSQLiteIdentifier(resource.name) === identifier);
}

function splitSelection(source: string): readonly string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let hintStarted = false;
  let relationOpened = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") {
      depth += 1;
      relationOpened = true;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0)
        throw invalidSelection("select has unmatched parentheses.");
    } else if (depth === 0 && character === "!" && !relationOpened) {
      hintStarted = true;
    } else if (depth === 0 && character === ",") {
      if (hintStarted && !relationOpened) continue;
      items.push(source.slice(start, index));
      start = index + 1;
      hintStarted = false;
      relationOpened = false;
    }
  }

  if (depth !== 0) throw invalidSelection("select has unmatched parentheses.");
  items.push(source.slice(start));
  if (items.some((item) => item.length === 0 || item.trim() !== item)) {
    throw invalidSelection(
      "select contains an empty or whitespace-padded item.",
    );
  }
  return Object.freeze(items);
}

function splitAlias(value: string): {
  readonly alias?: string;
  readonly target: string;
} {
  const firstColon = value.indexOf(":");
  if (firstColon < 0) return { target: value };
  if (firstColon !== value.lastIndexOf(":")) {
    throw invalidSelection(
      "A select item contains more than one alias separator.",
    );
  }

  const alias = value.slice(0, firstColon);
  const target = value.slice(firstColon + 1);
  if (!alias || !target) {
    throw invalidSelection(
      "Select aliases and their targets must be non-empty.",
    );
  }
  return { alias, target };
}

function parseRelationReference(value: string): {
  readonly resource: string;
  readonly hint?: string;
} {
  const bang = value.indexOf("!");
  if (bang < 0) {
    if (!value) throw invalidSelection("Relation resources must be non-empty.");
    return { resource: value };
  }
  if (bang !== value.lastIndexOf("!")) {
    throw invalidSelection("A relation contains more than one hint separator.");
  }

  const resource = value.slice(0, bang);
  const rawHint = value.slice(bang + 1);
  const hintParts = rawHint.split(",").map((part) => part.trim());
  if (!resource || hintParts.some((part) => !part)) {
    throw invalidSelection("Relation resources and hints must be non-empty.");
  }
  return { resource, hint: hintParts.join(",") };
}

function addOutputName(outputNames: Set<string>, name: string): void {
  if (outputNames.has(name)) {
    throw invalidSelection(
      `Output name ${JSON.stringify(name)} appears more than once in select.`,
    );
  }
  outputNames.add(name);
}

function parseSelectionLevel(
  source: string,
  resource: DatabaseResource,
  schema: DatabaseSchema,
  relationships: DatabaseRelationshipGraph,
  maxDepth: number,
  relationDepth: number,
  budget: SelectionBudget,
): readonly SelectionPlanNode[] {
  if (!source || source.length > MAX_SELECT_LENGTH) {
    throw invalidSelection(
      source.length > MAX_SELECT_LENGTH
        ? `select exceeds the ${MAX_SELECT_LENGTH} character limit.`
        : "select must not be empty.",
    );
  }

  const nodes: SelectionPlanNode[] = [];
  const outputNames = new Set<string>();
  for (const item of splitSelection(source)) {
    const open = item.indexOf("(");
    if (open < 0) {
      const { alias, target } = splitAlias(item);
      if (target === "*") {
        if (alias !== undefined) {
          throw invalidSelection(
            "The wildcard selection cannot have an alias.",
          );
        }
        for (const column of resource.columns) {
          reserveSelectionNode(budget);
          addOutputName(outputNames, column.name);
          nodes.push(Object.freeze({ kind: "column", column: column.name }));
        }
        continue;
      }

      if (item.includes(")") || target.includes("!")) {
        throw invalidSelection("A relation selection is malformed.");
      }
      const column = getFilterColumn(resource, target);
      if (!column) throw unknownColumn(resource, target);
      const outputName = alias ?? column.name;
      reserveSelectionNode(budget);
      addOutputName(outputNames, outputName);
      nodes.push(
        Object.freeze({
          kind: "column",
          column: column.name,
          ...(alias === undefined ? {} : { alias }),
        }),
      );
      continue;
    }

    if (!item.endsWith(")") || item.indexOf(")") < open) {
      throw invalidSelection("A relation selection is malformed.");
    }
    const header = item.slice(0, open);
    const nestedSource = item.slice(open + 1, -1);
    const { alias, target: rawReference } = splitAlias(header);
    const reference = parseRelationReference(rawReference);

    const nextDepth = relationDepth + 1;
    if (nextDepth > maxDepth) throw relationDepthExceeded(maxDepth);
    const target = getResource(schema, reference.resource);
    if (!target) {
      relationships.resolve(resource.name, reference.resource, reference.hint);
      throw new Error("Relationship resolution unexpectedly succeeded");
    }
    relationships.resolve(resource.name, target.name, reference.hint);

    const outputName = alias ?? target.name;
    reserveSelectionNode(budget);
    addOutputName(outputNames, outputName);
    nodes.push(
      Object.freeze({
        kind: "relation",
        resource: target.name,
        ...(alias === undefined ? {} : { alias }),
        ...(reference.hint === undefined ? {} : { hint: reference.hint }),
        target,
        selection: parseSelectionLevel(
          nestedSource,
          target,
          schema,
          relationships,
          maxDepth,
          nextDepth,
          budget,
        ),
      }),
    );
  }

  return Object.freeze(nodes);
}

/** Parses and resolves scalar and relationship selection syntax. */
export function parseRestSelection(
  source: string,
  resource: DatabaseResource,
  schema: DatabaseSchema,
  relationships: DatabaseRelationshipGraph,
  maxDepth: number,
): readonly SelectionPlanNode[] {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative safe integer");
  }
  return parseSelectionLevel(
    source,
    resource,
    schema,
    relationships,
    maxDepth,
    0,
    { count: 0 },
  );
}
