import { SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import type {
  ResolvedAuthorization,
  RestAuthorizationResolver,
} from "../auth/types";
import type { RestConfig } from "../config";
import type { Database } from "../database/database";
import type {
  DatabaseRelationship,
  DatabaseRelationshipGraph,
  ManyToManyRelationship,
} from "../database/relationships";
import type {
  DatabaseColumn,
  DatabaseResource,
  DatabaseSchema,
} from "../database/schema";
import { RestError } from "../http/errors";
import type { RestScalar } from "../query/filter";
import { compileRestFilter } from "../query/filter-compiler";
import type { RestQuery, SelectionNode } from "../query/query";
import { serializeSQLiteValue } from "../serialization/value";
import type { ReadExecutionResult } from "./read";
import { quoteIdentifier } from "./sql";

export interface RelationExecutionContext {
  readonly database: Database;
  readonly schema: DatabaseSchema;
  readonly relationships: DatabaseRelationshipGraph;
  readonly authorization: RestAuthorizationResolver;
  readonly request: Request;
  readonly config: Pick<RestConfig, "maxRows" | "maxEmbedDepth">;
}

interface RelationExecutionPlan {
  readonly selection: Extract<SelectionNode, { readonly kind: "relation" }>;
  readonly outputName: string;
  readonly relationship: DatabaseRelationship;
  readonly target: DatabaseResource;
  readonly authorization: ResolvedAuthorization;
  readonly junction?: {
    readonly resource: DatabaseResource;
    readonly authorization: ResolvedAuthorization;
  };
  readonly children: readonly RelationExecutionPlan[];
}

interface StoredValue {
  readonly value: unknown;
  readonly storageType: string;
}

interface MaterializedRow {
  readonly output: Record<string, unknown>;
  readonly values: ReadonlyMap<string, StoredValue>;
}

interface Projection {
  readonly column: DatabaseColumn;
  readonly valueAlias: string;
  readonly typeAlias: string;
}

type SqlRow = Record<string, unknown>;

// SQLite defaults to at least this limit in every version supported by Bun.
// Keep statements comfortably below it even when Bun is built with a higher
// SQLITE_MAX_VARIABLE_NUMBER, and cap VALUES clauses independently.
const SQLITE_BOUND_VARIABLE_LIMIT = 32_766;
const MAX_PARENT_KEYS_PER_BATCH = 1_000;
const EMPTY_PARAMETERS: readonly RestScalar[] = Object.freeze([]);

function getResource(schema: DatabaseSchema, name: string): DatabaseResource {
  const resource = schema.getResource(name);
  if (resource === undefined) {
    throw new TypeError("Resolved relationship resource is unavailable");
  }
  return resource;
}

async function buildRelationPlans(
  context: RelationExecutionContext,
  source: DatabaseResource,
  selection: readonly SelectionNode[],
): Promise<readonly RelationExecutionPlan[]> {
  const plans: RelationExecutionPlan[] = [];

  for (const node of selection) {
    if (node.kind !== "relation") continue;

    const relationship = context.relationships.resolve(
      source.name,
      node.resource,
      node.hint,
    );
    const target = getResource(context.schema, relationship.target);
    const authorization = await context.authorization.resolve({
      request: context.request,
      resource: target,
      operation: "select",
      ...(node.query.filter === undefined
        ? {}
        : { clientFilter: node.query.filter }),
    });
    let junction: RelationExecutionPlan["junction"];

    if (relationship.kind === "many-to-many") {
      const resource = getResource(
        context.schema,
        relationship.junction.resource,
      );
      junction = Object.freeze({
        resource,
        authorization: await context.authorization.resolve({
          request: context.request,
          resource,
          operation: "select",
        }),
      });
    }

    plans.push(
      Object.freeze({
        selection: node,
        outputName: node.alias ?? target.name,
        relationship,
        target,
        authorization,
        ...(junction === undefined ? {} : { junction }),
        children: await buildRelationPlans(
          context,
          target,
          node.query.selection,
        ),
      }),
    );
  }

  return Object.freeze(plans);
}

function requiredColumns(
  resource: DatabaseResource,
  query: RestQuery,
  plans: readonly RelationExecutionPlan[],
): readonly DatabaseColumn[] {
  const names = new Set<string>();
  for (const node of query.selection) {
    if (node.kind === "column") names.add(node.column);
  }
  for (const plan of plans) {
    const mappings =
      plan.relationship.kind === "many-to-many"
        ? plan.relationship.junction.sourceColumnMappings
        : plan.relationship.columnMappings;
    for (const mapping of mappings) names.add(mapping.source);
  }

  return Object.freeze(
    resource.columns.filter((column) => names.has(column.name)),
  );
}

function buildProjections(
  columns: readonly DatabaseColumn[],
): readonly Projection[] {
  return Object.freeze(
    columns.map((column, index) =>
      Object.freeze({
        column,
        valueAlias: `__slrest_value_${index}`,
        typeAlias: `__slrest_type_${index}`,
      }),
    ),
  );
}

function projectionSql(
  projections: readonly Projection[],
  tableAlias: string,
): string {
  const quotedAlias = quoteIdentifier(tableAlias);
  return projections
    .flatMap(({ column, valueAlias, typeAlias }) => {
      const value = `${quotedAlias}.${quoteIdentifier(column.name)}`;
      return [
        `CASE WHEN typeof(${value}) = 'integer' THEN CAST(${value} AS TEXT) ELSE ${value} END AS ${quoteIdentifier(valueAlias)}`,
        `typeof(${value}) AS ${quoteIdentifier(typeAlias)}`,
      ];
    })
    .join(", ");
}

function materializeRow(
  rawRow: SqlRow,
  resource: DatabaseResource,
  query: RestQuery,
  projections: readonly Projection[],
): MaterializedRow {
  const values = new Map<string, StoredValue>();
  for (const projection of projections) {
    const storageType = rawRow[projection.typeAlias];
    if (typeof storageType !== "string") throw new RestError("SLREST504");
    values.set(
      projection.column.name,
      Object.freeze({
        value: rawRow[projection.valueAlias],
        storageType,
      }),
    );
  }

  const output: Record<string, unknown> = {};
  for (const node of query.selection) {
    if (node.kind !== "column") continue;
    const stored = values.get(node.column);
    const column = projections.find(
      (projection) => projection.column.name === node.column,
    )?.column;
    if (stored === undefined || column === undefined) {
      throw new TypeError("Resolved selection metadata is unavailable");
    }
    const exactValue =
      stored.storageType === "integer" && typeof stored.value === "string"
        ? BigInt(stored.value)
        : stored.value;
    output[node.alias ?? node.column] = serializeSQLiteValue(
      exactValue,
      column,
      resource.name,
      stored.storageType,
    );
  }

  return { output, values };
}

function compileAuthorization(
  authorization: ResolvedAuthorization,
  resource: DatabaseResource,
  alias: string,
): { readonly sql?: string; readonly parameters: readonly RestScalar[] } {
  if (authorization.using === undefined) {
    return { parameters: EMPTY_PARAMETERS };
  }
  return compileRestFilter(authorization.using, resource, alias);
}

function orderSql(
  resource: DatabaseResource,
  query: RestQuery,
  alias: string,
): string {
  const terms: string[] = [];
  const ordered = new Set<string>();
  const quotedAlias = quoteIdentifier(alias);

  for (const term of query.order) {
    ordered.add(term.field);
    const nulls =
      term.nulls === undefined ? "" : ` NULLS ${term.nulls.toUpperCase()}`;
    terms.push(
      `${quotedAlias}.${quoteIdentifier(term.field)} ${term.direction.toUpperCase()}${nulls}`,
    );
  }

  for (const column of resource.columns) {
    if (ordered.has(column.name)) continue;
    terms.push(`${quotedAlias}.${quoteIdentifier(column.name)} ASC`);
  }

  return terms.join(", ");
}

function storedBinding(stored: StoredValue): SQLQueryBindings {
  if (stored.storageType === "integer" && typeof stored.value === "string") {
    return BigInt(stored.value);
  }
  if (
    stored.value === null ||
    typeof stored.value === "string" ||
    typeof stored.value === "number" ||
    typeof stored.value === "bigint" ||
    typeof stored.value === "boolean" ||
    stored.value instanceof Uint8Array
  ) {
    return stored.value;
  }
  throw new RestError("SLREST504");
}

function storedSignature(stored: StoredValue): string {
  if (stored.value instanceof Uint8Array) {
    return `${stored.storageType}:${Array.from(stored.value, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  return `${stored.storageType}:${String(stored.value)}`;
}

function parentKey(
  row: MaterializedRow,
  relationship: DatabaseRelationship,
): {
  readonly signature: string;
  readonly bindings: readonly SQLQueryBindings[];
} | null {
  const mappings =
    relationship.kind === "many-to-many"
      ? relationship.junction.sourceColumnMappings
      : relationship.columnMappings;
  const stored = mappings.map((mapping) => row.values.get(mapping.source));
  if (stored.some((value) => value === undefined || value.value === null)) {
    return null;
  }
  const exact = stored as StoredValue[];
  return Object.freeze({
    signature: JSON.stringify(exact.map(storedSignature)),
    bindings: Object.freeze(exact.map(storedBinding)),
  });
}

function relationTargetMappings(
  relationship: DatabaseRelationship,
): readonly { readonly source: string; readonly target: string }[] {
  return relationship.kind === "many-to-many"
    ? relationship.junction.sourceColumnMappings
    : relationship.columnMappings;
}

function parentCte(
  keys: readonly {
    readonly signature: string;
    readonly bindings: readonly SQLQueryBindings[];
  }[],
): { readonly sql: string; readonly parameters: readonly SQLQueryBindings[] } {
  const width = keys[0]?.bindings.length ?? 0;
  const columns = [
    quoteIdentifier("__parent_id"),
    ...Array.from({ length: width }, (_, index) =>
      quoteIdentifier(`__parent_key_${index}`),
    ),
  ];
  const parameters: SQLQueryBindings[] = [];
  const values = keys.map((key, index) => {
    parameters.push(...key.bindings);
    return `(${index}, ${key.bindings.map(() => "?").join(", ")})`;
  });
  return Object.freeze({
    sql: `${quoteIdentifier("__slrest_parents")} (${columns.join(", ")}) AS (VALUES ${values.join(", ")})`,
    parameters: Object.freeze(parameters),
  });
}

function relationJoinSql(
  relationship: DatabaseRelationship,
  targetAlias: string,
  junctionAlias: string,
): string {
  const parentAlias = quoteIdentifier("__slrest_parents");
  const target = quoteIdentifier(targetAlias);
  const mappings = relationTargetMappings(relationship);

  if (relationship.kind !== "many-to-many") {
    return mappings
      .map(
        (mapping, index) =>
          `${target}.${quoteIdentifier(mapping.target)} = ${parentAlias}.${quoteIdentifier(`__parent_key_${index}`)}`,
      )
      .join(" AND ");
  }

  const junction = quoteIdentifier(junctionAlias);
  const sourceJoin = relationship.junction.sourceColumnMappings
    .map(
      (mapping, index) =>
        `${junction}.${quoteIdentifier(mapping.target)} = ${parentAlias}.${quoteIdentifier(`__parent_key_${index}`)}`,
    )
    .join(" AND ");
  const targetJoin = relationship.junction.targetColumnMappings
    .map(
      (mapping) =>
        `${target}.${quoteIdentifier(mapping.target)} = ${junction}.${quoteIdentifier(mapping.source)}`,
    )
    .join(" AND ");
  return `${sourceJoin} JOIN ${quoteIdentifier(relationship.target)} AS ${target} ON ${targetJoin}`;
}

function freezeRows(rows: readonly MaterializedRow[]): void {
  for (const row of rows) Object.freeze(row.output);
}

function fetchRelatedRows(
  context: RelationExecutionContext,
  parentRows: readonly MaterializedRow[],
  plan: RelationExecutionPlan,
): ReadonlyMap<string, readonly MaterializedRow[]> {
  const keysBySignature = new Map<
    string,
    {
      readonly signature: string;
      readonly bindings: readonly SQLQueryBindings[];
    }
  >();
  for (const row of parentRows) {
    const key = parentKey(row, plan.relationship);
    if (key !== null && !keysBySignature.has(key.signature)) {
      keysBySignature.set(key.signature, key);
    }
  }
  const keys = [...keysBySignature.values()];
  const groups = new Map<string, MaterializedRow[]>();
  if (keys.length === 0 || plan.selection.query.limit === 0) return groups;

  const targetAlias = "__slrest_related";
  const junctionAlias = "__slrest_junction";
  const columns = requiredColumns(
    plan.target,
    plan.selection.query,
    plan.children,
  );
  const projections = buildProjections(columns);
  const targetAuthorization = compileAuthorization(
    plan.authorization,
    plan.target,
    targetAlias,
  );
  const junctionAuthorization =
    plan.junction === undefined
      ? { parameters: EMPTY_PARAMETERS }
      : compileAuthorization(
          plan.junction.authorization,
          plan.junction.resource,
          junctionAlias,
        );
  const fixedParameterCount =
    targetAuthorization.parameters.length +
    junctionAuthorization.parameters.length +
    2;
  const keyWidth = keys[0]?.bindings.length ?? 1;
  const batchSize = Math.min(
    MAX_PARENT_KEYS_PER_BATCH,
    Math.floor((SQLITE_BOUND_VARIABLE_LIMIT - fixedParameterCount) / keyWidth),
  );
  if (batchSize < 1) {
    throw new RestError("SLREST103", {
      details: "Embedded filters leave no SQLite parameters for relation keys.",
      hint: "Reduce the number of embedded filter values.",
    });
  }
  const requestedEnd = Math.min(
    Number.MAX_SAFE_INTEGER,
    plan.selection.query.offset +
      (plan.relationship.kind === "direct"
        ? Math.min(1, plan.selection.query.limit)
        : plan.selection.query.limit),
  );

  for (let start = 0; start < keys.length; start += batchSize) {
    const batch = keys.slice(start, start + batchSize);
    const cte = parentCte(batch);
    const parent = quoteIdentifier("__slrest_parents");
    const target = quoteIdentifier(targetAlias);
    const targetFrom =
      plan.relationship.kind === "many-to-many"
        ? `${parent} JOIN ${quoteIdentifier(
            (plan.relationship as ManyToManyRelationship).junction.resource,
          )} AS ${quoteIdentifier(junctionAlias)} ON ${relationJoinSql(
            plan.relationship,
            targetAlias,
            junctionAlias,
          )}`
        : `${parent} JOIN ${quoteIdentifier(plan.target.name)} AS ${target} ON ${relationJoinSql(
            plan.relationship,
            targetAlias,
            junctionAlias,
          )}`;
    const filters = [targetAuthorization.sql, junctionAuthorization.sql].filter(
      (sql): sql is string => sql !== undefined,
    );
    const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
    const sql = `WITH ${cte.sql}, ${quoteIdentifier("__slrest_ranked")} AS (SELECT ${parent}.${quoteIdentifier("__parent_id")} AS ${quoteIdentifier("__parent_id")}, ${projectionSql(projections, targetAlias)}, ROW_NUMBER() OVER (PARTITION BY ${parent}.${quoteIdentifier("__parent_id")} ORDER BY ${orderSql(plan.target, plan.selection.query, targetAlias)}) AS ${quoteIdentifier("__rank")} FROM ${targetFrom}${where}) SELECT * FROM ${quoteIdentifier("__slrest_ranked")} WHERE ${quoteIdentifier("__rank")} > ? AND ${quoteIdentifier("__rank")} <= ? ORDER BY ${quoteIdentifier("__parent_id")}, ${quoteIdentifier("__rank")}`;
    const rawRows = context.database
      .query<SqlRow, SQLQueryBindings[]>(sql)
      .all(
        ...cte.parameters,
        ...targetAuthorization.parameters,
        ...junctionAuthorization.parameters,
        plan.selection.query.offset,
        requestedEnd,
      );

    for (const rawRow of rawRows) {
      const parentId = rawRow.__parent_id;
      if (typeof parentId !== "number" || !Number.isSafeInteger(parentId)) {
        throw new RestError("SLREST504");
      }
      const key = batch[parentId];
      if (key === undefined) throw new RestError("SLREST504");
      const row = materializeRow(
        rawRow,
        plan.target,
        plan.selection.query,
        projections,
      );
      const group = groups.get(key.signature);
      if (group === undefined) groups.set(key.signature, [row]);
      else group.push(row);
    }
  }

  return groups;
}

function attachRelations(
  context: RelationExecutionContext,
  parentRows: readonly MaterializedRow[],
  plans: readonly RelationExecutionPlan[],
): void {
  for (const plan of plans) {
    const groups = fetchRelatedRows(context, parentRows, plan);
    const childRows = [...groups.values()].flat();
    attachRelations(context, childRows, plan.children);
    freezeRows(childRows);

    for (const row of parentRows) {
      const key = parentKey(row, plan.relationship);
      const children = key === null ? undefined : groups.get(key.signature);
      row.output[plan.outputName] =
        plan.relationship.kind === "direct"
          ? (children?.[0]?.output ?? null)
          : Object.freeze((children ?? []).map((child) => child.output));
    }
  }
}

function parseTotal(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new RestError("SLREST504");
  }
  const total = Number(value);
  if (!Number.isSafeInteger(total)) throw new RestError("SLREST504");
  return total;
}

function executeRootRead(
  context: RelationExecutionContext,
  resource: DatabaseResource,
  query: RestQuery,
  authorization: ResolvedAuthorization,
  plans: readonly RelationExecutionPlan[],
): ReadExecutionResult {
  const alias = "__slrest_resource";
  const columns = requiredColumns(resource, query, plans);
  const projections = buildProjections(columns);
  const compiledAuthorization = compileAuthorization(
    authorization,
    resource,
    alias,
  );
  const where =
    compiledAuthorization.sql === undefined
      ? ""
      : ` WHERE ${compiledAuthorization.sql}`;
  const from = `${quoteIdentifier(resource.name)} AS ${quoteIdentifier(alias)}`;
  const order =
    query.order.length === 0
      ? ""
      : ` ORDER BY ${orderSql(resource, query, alias)}`;
  let total: number | null = null;

  if (query.countExact) {
    const countRow = context.database
      .query<{ __slrest_total: unknown }, SQLQueryBindings[]>(
        `SELECT CAST(COUNT(*) AS TEXT) AS ${quoteIdentifier("__slrest_total")} FROM ${from}${where}`,
      )
      .get(...compiledAuthorization.parameters);
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

  const rawRows = context.database
    .query<SqlRow, SQLQueryBindings[]>(
      `SELECT ${projectionSql(projections, alias)} FROM ${from}${where}${order} LIMIT ? OFFSET ?`,
    )
    .all(...compiledAuthorization.parameters, query.limit, query.offset);
  const materialized = rawRows.map((row) =>
    materializeRow(row, resource, query, projections),
  );
  attachRelations(context, materialized, plans);
  freezeRows(materialized);
  const rows = Object.freeze(materialized.map((row) => row.output));

  return Object.freeze({
    rows,
    rangeStart: query.offset,
    rangeEnd: rows.length === 0 ? null : query.offset + rows.length - 1,
    total,
  });
}

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

/** Resolves relation authorization, then executes and assembles one read tree. */
export async function executeRelationRead(
  context: RelationExecutionContext,
  rootResource: DatabaseResource,
  query: RestQuery,
  rootAuthorization: ResolvedAuthorization,
): Promise<ReadExecutionResult> {
  const plans = await buildRelationPlans(
    context,
    rootResource,
    query.selection,
  );
  const read = context.database.transaction(() =>
    executeRootRead(context, rootResource, query, rootAuthorization, plans),
  );

  try {
    return read();
  } catch (error) {
    return mapDatabaseError(error);
  }
}
