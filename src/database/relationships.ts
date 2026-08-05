import type {
  DatabaseForeignKey,
  DatabaseResource,
  DatabaseSchema,
} from "./schema";

export interface ColumnMapping {
  readonly source: string;
  readonly target: string;
}

interface RelationshipBase {
  readonly source: string;
  readonly target: string;
  readonly hint: string;
}

export interface DirectRelationship extends RelationshipBase {
  readonly kind: "direct";
  readonly cardinality: "many-to-one";
  readonly columnMappings: readonly ColumnMapping[];
}

export interface InverseRelationship extends RelationshipBase {
  readonly kind: "inverse";
  readonly cardinality: "one-to-many";
  readonly columnMappings: readonly ColumnMapping[];
}

export interface JunctionRelationshipMetadata {
  readonly resource: string;
  readonly sourceColumnMappings: readonly ColumnMapping[];
  readonly targetColumnMappings: readonly ColumnMapping[];
}

export interface ManyToManyRelationship extends RelationshipBase {
  readonly kind: "many-to-many";
  readonly cardinality: "many-to-many";
  readonly junction: JunctionRelationshipMetadata;
}

export type DatabaseRelationship =
  | DirectRelationship
  | InverseRelationship
  | ManyToManyRelationship;

export type RelationshipResolutionErrorCode = "SLREST202" | "SLREST203";

/** A safe, transport-ready failure produced while resolving a relationship. */
export class RelationshipResolutionError extends Error {
  readonly code: RelationshipResolutionErrorCode;
  readonly status: 300 | 400;
  readonly details: string;
  readonly hint: string | null;

  constructor(options: {
    code: RelationshipResolutionErrorCode;
    status: 300 | 400;
    message: string;
    details: string;
    hint: string | null;
  }) {
    super(options.message);
    this.name = "RelationshipResolutionError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.hint = options.hint;
  }
}

export interface DatabaseRelationshipGraph {
  listFrom(resource: string): readonly DatabaseRelationship[];
  resolve(source: string, target: string, hint?: string): DatabaseRelationship;
}

const EMPTY_RELATIONSHIPS: readonly DatabaseRelationship[] = Object.freeze([]);
const RELATIONSHIP_KIND_ORDER = {
  direct: 0,
  inverse: 1,
  "many-to-many": 2,
} as const;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareColumnMappings(
  left: readonly ColumnMapping[],
  right: readonly ColumnMapping[],
): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftMapping = left[index];
    const rightMapping = right[index];
    if (!leftMapping || !rightMapping) continue;

    const comparison =
      compareStrings(leftMapping.source, rightMapping.source) ||
      compareStrings(leftMapping.target, rightMapping.target);
    if (comparison !== 0) return comparison;
  }

  return left.length - right.length;
}

function getPrimaryColumnMappings(
  relationship: DatabaseRelationship,
): readonly ColumnMapping[] {
  return relationship.kind === "many-to-many"
    ? relationship.junction.sourceColumnMappings
    : relationship.columnMappings;
}

function compareRelationships(
  left: DatabaseRelationship,
  right: DatabaseRelationship,
): number {
  const commonComparison =
    compareStrings(left.source, right.source) ||
    compareStrings(left.target, right.target) ||
    RELATIONSHIP_KIND_ORDER[left.kind] - RELATIONSHIP_KIND_ORDER[right.kind] ||
    compareStrings(left.hint, right.hint) ||
    compareColumnMappings(
      getPrimaryColumnMappings(left),
      getPrimaryColumnMappings(right),
    );
  if (commonComparison !== 0) return commonComparison;

  if (left.kind !== "many-to-many" || right.kind !== "many-to-many") {
    return 0;
  }

  return (
    compareStrings(left.junction.resource, right.junction.resource) ||
    compareColumnMappings(
      left.junction.targetColumnMappings,
      right.junction.targetColumnMappings,
    )
  );
}

function freezeColumnMappings(
  sourceColumns: readonly string[],
  targetColumns: readonly string[],
): readonly ColumnMapping[] {
  if (
    sourceColumns.length === 0 ||
    sourceColumns.length !== targetColumns.length
  ) {
    throw Error("Foreign-key metadata has invalid column mappings");
  }

  return Object.freeze(
    sourceColumns.map((source, index) => {
      const target = targetColumns[index];
      if (target === undefined) {
        throw Error("Foreign-key metadata has invalid column mappings");
      }

      return Object.freeze({ source, target });
    }),
  );
}

function getRelationshipHint(foreignKey: DatabaseForeignKey): string {
  return foreignKey.fromColumns.join(",");
}

function createDirectRelationship(
  source: DatabaseResource,
  target: DatabaseResource,
  foreignKey: DatabaseForeignKey,
): DirectRelationship {
  return Object.freeze({
    kind: "direct",
    source: source.name,
    target: target.name,
    cardinality: "many-to-one",
    columnMappings: freezeColumnMappings(
      foreignKey.fromColumns,
      foreignKey.referencedColumns,
    ),
    hint: getRelationshipHint(foreignKey),
  });
}

function createInverseRelationship(
  source: DatabaseResource,
  target: DatabaseResource,
  foreignKey: DatabaseForeignKey,
): InverseRelationship {
  return Object.freeze({
    kind: "inverse",
    source: target.name,
    target: source.name,
    cardinality: "one-to-many",
    columnMappings: freezeColumnMappings(
      foreignKey.referencedColumns,
      foreignKey.fromColumns,
    ),
    hint: getRelationshipHint(foreignKey),
  });
}

function hasQualifyingJunctionConstraint(junction: DatabaseResource): boolean {
  if (junction.foreignKeys.length !== 2) return false;

  const combinedColumns = junction.foreignKeys.flatMap(
    (foreignKey) => foreignKey.fromColumns,
  );
  const combinedColumnSet = new Set(combinedColumns);

  if (combinedColumns.length !== combinedColumnSet.size) return false;

  return junction.uniqueConstraints.some((constraint) => {
    const constraintColumnSet = new Set(constraint.columns);

    return (
      constraint.columns.length === combinedColumns.length &&
      constraintColumnSet.size === combinedColumnSet.size &&
      constraint.columns.every((column) => combinedColumnSet.has(column))
    );
  });
}

function createManyToManyRelationship(
  junction: DatabaseResource,
  sourceForeignKey: DatabaseForeignKey,
  targetForeignKey: DatabaseForeignKey,
): ManyToManyRelationship {
  return Object.freeze({
    kind: "many-to-many",
    source: sourceForeignKey.referencedResource,
    target: targetForeignKey.referencedResource,
    cardinality: "many-to-many",
    hint: getRelationshipHint(sourceForeignKey),
    junction: Object.freeze({
      resource: junction.name,
      sourceColumnMappings: freezeColumnMappings(
        sourceForeignKey.referencedColumns,
        sourceForeignKey.fromColumns,
      ),
      targetColumnMappings: freezeColumnMappings(
        targetForeignKey.fromColumns,
        targetForeignKey.referencedColumns,
      ),
    }),
  });
}

function relationshipNotFound(
  source: string,
  target: string,
): RelationshipResolutionError {
  return new RelationshipResolutionError({
    code: "SLREST202",
    status: 400,
    message: "Relationship not found",
    details: `No inferred relationship exists from resource ${JSON.stringify(source)} to resource ${JSON.stringify(target)}.`,
    hint: null,
  });
}

function formatAvailableHints(
  relationships: readonly DatabaseRelationship[],
): string {
  return [...new Set(relationships.map(({ hint }) => hint))]
    .sort(compareStrings)
    .map((hint) => JSON.stringify(hint))
    .join(", ");
}

function relationshipHintNotFound(
  source: string,
  target: string,
  relationships: readonly DatabaseRelationship[],
): RelationshipResolutionError {
  return new RelationshipResolutionError({
    code: "SLREST202",
    status: 400,
    message: "Relationship not found",
    details: `The inferred relationship from resource ${JSON.stringify(source)} to resource ${JSON.stringify(target)} does not match the supplied hint.`,
    hint: `Use relationship hint ${formatAvailableHints(relationships)}.`,
  });
}

function ambiguousRelationship(
  source: string,
  target: string,
  relationships: readonly DatabaseRelationship[],
): RelationshipResolutionError {
  return new RelationshipResolutionError({
    code: "SLREST203",
    status: 300,
    message: "Multiple Choices",
    details: `Multiple inferred relationships exist from resource ${JSON.stringify(source)} to resource ${JSON.stringify(target)}.`,
    hint: `Use one of these relationship hints: ${formatAvailableHints(relationships)}.`,
  });
}

/** Builds a deterministic, deeply immutable graph from a schema snapshot. */
export function buildRelationshipGraph(
  schema: DatabaseSchema,
): DatabaseRelationshipGraph {
  const resources = [...schema.listResources()].sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  const resourcesByName = new Map(
    resources.map((resource) => [resource.name, resource]),
  );
  const relationships: DatabaseRelationship[] = [];

  for (const source of resources) {
    if (source.kind !== "table") continue;

    for (const foreignKey of source.foreignKeys) {
      const target = resourcesByName.get(foreignKey.referencedResource);
      if (target?.kind !== "table") continue;

      relationships.push(
        createDirectRelationship(source, target, foreignKey),
        createInverseRelationship(source, target, foreignKey),
      );
    }

    if (!hasQualifyingJunctionConstraint(source)) continue;

    const firstForeignKey = source.foreignKeys[0];
    const secondForeignKey = source.foreignKeys[1];
    if (!firstForeignKey || !secondForeignKey) continue;

    const firstTarget = resourcesByName.get(firstForeignKey.referencedResource);
    const secondTarget = resourcesByName.get(
      secondForeignKey.referencedResource,
    );
    if (firstTarget?.kind !== "table" || secondTarget?.kind !== "table") {
      continue;
    }

    relationships.push(
      createManyToManyRelationship(source, firstForeignKey, secondForeignKey),
      createManyToManyRelationship(source, secondForeignKey, firstForeignKey),
    );
  }

  relationships.sort(compareRelationships);

  const relationshipsBySource = new Map<
    string,
    readonly DatabaseRelationship[]
  >();

  for (const resource of resources) {
    relationshipsBySource.set(
      resource.name,
      Object.freeze(
        relationships.filter(
          (relationship) => relationship.source === resource.name,
        ),
      ),
    );
  }

  return Object.freeze({
    listFrom(resource: string): readonly DatabaseRelationship[] {
      return relationshipsBySource.get(resource) ?? EMPTY_RELATIONSHIPS;
    },
    resolve(
      source: string,
      target: string,
      hint?: string,
    ): DatabaseRelationship {
      const candidates = (relationshipsBySource.get(source) ?? []).filter(
        (relationship) => relationship.target === target,
      );
      const matches =
        hint === undefined
          ? candidates
          : candidates.filter((relationship) => relationship.hint === hint);

      if (matches.length === 1) {
        const relationship = matches[0];
        if (relationship) return relationship;
      }
      if (matches.length > 1) {
        throw ambiguousRelationship(source, target, matches);
      }
      if (candidates.length > 1) {
        throw ambiguousRelationship(source, target, candidates);
      }
      if (candidates.length === 1) {
        throw relationshipHintNotFound(source, target, candidates);
      }

      throw relationshipNotFound(source, target);
    },
  });
}
