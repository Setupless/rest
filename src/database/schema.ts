import type { Database } from "./database";

export type SQLiteAffinity = "integer" | "real" | "text" | "blob" | "numeric";

export interface DatabaseColumn {
  readonly cid: number;
  readonly name: string;
  readonly declaredType: string;
  readonly affinity: SQLiteAffinity;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number | null;
  readonly generated: false | "virtual" | "stored";
  readonly writable: boolean;
}

export interface DatabaseUniqueConstraint {
  readonly columns: readonly string[];
  readonly primary: boolean;
}

export interface DatabaseForeignKey {
  readonly id: number;
  readonly fromColumns: readonly string[];
  readonly referencedResource: string;
  readonly referencedColumns: readonly string[];
}

export interface DatabaseResource {
  readonly name: string;
  readonly kind: "table" | "view" | "virtual-table";
  readonly writable: boolean;
  readonly columns: readonly DatabaseColumn[];
  readonly primaryKey: readonly string[];
  readonly uniqueConstraints: readonly DatabaseUniqueConstraint[];
  readonly foreignKeys: readonly DatabaseForeignKey[];
}

interface ResourceRow {
  name: string;
  schema_type: "table" | "view";
  table_list_type: "table" | "view" | "virtual";
  without_rowid: 0 | 1;
  strict: 0 | 1;
}

interface ColumnRow {
  cid: number;
  name: string;
  declared_type: string;
  not_null: 0 | 1;
  default_value: string | null;
  primary_key_position: number;
  hidden: 0 | 1 | 2 | 3;
}

interface PrimaryKeyIndexRow {
  present: 1;
}

interface IndexRow {
  name: string;
  unique: 0 | 1;
  origin: "c" | "u" | "pk";
  partial: 0 | 1;
}

interface IndexColumnRow {
  sequence: number;
  column_id: number;
  name: string | null;
  key: 0 | 1;
}

interface ForeignKeyRow {
  id: number;
  sequence: number;
  referenced_resource: string;
  from_column: string;
  referenced_column: string | null;
}

interface NamedPragmaQuery<Row> {
  all(name: string): Row[];
}

export interface DatabaseSchema {
  getResource(name: string): DatabaseResource | undefined;
  listResources(): readonly DatabaseResource[];
}

/** Computes SQLite affinity using the documented, order-dependent rules. */
export function getSQLiteAffinity(declaredType: string): SQLiteAffinity {
  const normalizedType = declaredType.toUpperCase();

  if (normalizedType.includes("INT")) return "integer";
  if (
    normalizedType.includes("CHAR") ||
    normalizedType.includes("CLOB") ||
    normalizedType.includes("TEXT")
  ) {
    return "text";
  }
  if (!normalizedType || normalizedType.includes("BLOB")) return "blob";
  if (
    normalizedType.includes("REAL") ||
    normalizedType.includes("FLOA") ||
    normalizedType.includes("DOUB")
  ) {
    return "real";
  }

  return "numeric";
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? "";
    const rightValue = right[index] ?? "";
    const comparison =
      leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    if (comparison !== 0) return comparison;
  }

  return left.length - right.length;
}

function foldSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

function loadUniqueConstraints(
  resourceName: string,
  primaryKey: readonly string[],
  indexListQuery: NamedPragmaQuery<IndexRow>,
  indexXInfoQuery: NamedPragmaQuery<IndexColumnRow>,
): readonly DatabaseUniqueConstraint[] {
  const constraints: DatabaseUniqueConstraint[] = [];

  if (primaryKey.length > 0) {
    constraints.push(
      Object.freeze({
        columns: primaryKey,
        primary: true,
      }),
    );
  }

  const indexRows = indexListQuery.all(resourceName);
  const uniqueIndexes = indexRows
    .filter(
      (index) =>
        index.unique === 1 && index.partial === 0 && index.origin !== "pk",
    )
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

  for (const index of uniqueIndexes) {
    const keyColumns = indexXInfoQuery
      .all(index.name)
      .filter((column) => column.key === 1)
      .sort((left, right) => left.sequence - right.sequence);
    const columns: string[] = [];
    let representable = keyColumns.length > 0;

    // An expression or rowid key cannot be represented safely by this
    // column-only contract, so the whole index is excluded as a target.
    for (const column of keyColumns) {
      if (column.column_id < 0 || column.name === null) {
        representable = false;
        break;
      }

      columns.push(column.name);
    }
    if (!representable) continue;

    constraints.push(
      Object.freeze({
        columns: Object.freeze(columns),
        primary: false,
      }),
    );
  }

  constraints.sort(
    (left, right) =>
      Number(right.primary) - Number(left.primary) ||
      compareStringArrays(left.columns, right.columns),
  );

  return Object.freeze(constraints);
}

function loadForeignKeys(
  resourceName: string,
  resourcesByIdentifier: ReadonlyMap<string, DatabaseResource>,
  foreignKeyListQuery: NamedPragmaQuery<ForeignKeyRow>,
): readonly DatabaseForeignKey[] {
  const rows = foreignKeyListQuery.all(resourceName);
  const rowsById = new Map<number, ForeignKeyRow[]>();

  for (const row of rows) {
    const group = rowsById.get(row.id);
    if (group) group.push(row);
    else rowsById.set(row.id, [row]);
  }

  const foreignKeys: DatabaseForeignKey[] = [];

  for (const [id, unorderedRows] of [...rowsById].sort(
    ([left], [right]) => left - right,
  )) {
    const constraintRows = unorderedRows.sort(
      (left, right) => left.sequence - right.sequence,
    );
    const referencedResourceName = constraintRows[0]?.referenced_resource;
    if (!referencedResourceName) continue;

    const referencedResource = resourcesByIdentifier.get(
      foldSQLiteIdentifier(referencedResourceName),
    );
    if (!referencedResource) continue;

    const explicitReferencedColumns = constraintRows.map(
      (row) => row.referenced_column,
    );
    const namedReferencedColumns = explicitReferencedColumns.filter(
      (column): column is string => column !== null,
    );
    let referencedColumns: readonly string[];

    if (namedReferencedColumns.length === explicitReferencedColumns.length) {
      const referencedColumnsByIdentifier = new Map(
        referencedResource.columns.map((column) => [
          foldSQLiteIdentifier(column.name),
          column.name,
        ]),
      );
      const canonicalReferencedColumns = namedReferencedColumns.map((column) =>
        referencedColumnsByIdentifier.get(foldSQLiteIdentifier(column)),
      );
      if (canonicalReferencedColumns.some((column) => column === undefined)) {
        continue;
      }

      referencedColumns = Object.freeze(
        canonicalReferencedColumns.filter(
          (column): column is string => column !== undefined,
        ),
      );
    } else {
      const referencedPrimaryKey = referencedResource.primaryKey;

      // SQLite only permits an omitted parent column list when the complete
      // parent primary key has the same arity as the child key.
      if (
        namedReferencedColumns.length > 0 ||
        !referencedPrimaryKey ||
        referencedPrimaryKey.length !== constraintRows.length
      ) {
        continue;
      }

      referencedColumns = referencedPrimaryKey;
    }

    foreignKeys.push(
      Object.freeze({
        id,
        fromColumns: Object.freeze(
          constraintRows.map((row) => row.from_column),
        ),
        referencedResource: referencedResource.name,
        referencedColumns,
      }),
    );
  }

  return Object.freeze(foreignKeys);
}

/** Loads one deeply immutable schema snapshot from SQLite's main schema. */
export function loadDatabaseSchema(database: Database): DatabaseSchema {
  const readSchema = database.transaction((): DatabaseSchema => {
    const resourceRows = database
      .query<ResourceRow, []>(
        `SELECT
           schema_resource.name,
           schema_resource.type AS schema_type,
           table_metadata.type AS table_list_type,
           table_metadata.wr AS without_rowid,
           table_metadata.strict
         FROM main.sqlite_schema AS schema_resource
         JOIN pragma_table_list AS table_metadata
           ON table_metadata."schema" = 'main'
          AND table_metadata.name = schema_resource.name
         WHERE schema_resource.type IN ('table', 'view')
           AND schema_resource.name NOT GLOB 'sqlite_*'
           AND table_metadata.type <> 'shadow'
         ORDER BY schema_resource.name`,
      )
      .all();

    const tableXInfoQuery = database.query<ColumnRow, [string]>(
      `SELECT
         cid,
         name,
         type AS declared_type,
         "notnull" AS not_null,
         dflt_value AS default_value,
         pk AS primary_key_position,
         hidden
       FROM pragma_table_xinfo(?, 'main')
       WHERE hidden <> 1
       ORDER BY cid`,
    );

    const primaryKeyIndexQuery = database.query<PrimaryKeyIndexRow, [string]>(
      `SELECT 1 AS present
       FROM pragma_index_list(?, 'main')
       WHERE origin = 'pk'
       LIMIT 1`,
    );

    const indexListQuery = database.query<IndexRow, [string]>(
      `SELECT
         name,
         "unique",
         origin,
         partial
       FROM pragma_index_list(?, 'main')`,
    );

    const indexXInfoQuery = database.query<IndexColumnRow, [string]>(
      `SELECT
         seqno AS sequence,
         cid AS column_id,
         name,
         key
       FROM pragma_index_xinfo(?, 'main')`,
    );

    const foreignKeyListQuery = database.query<ForeignKeyRow, [string]>(
      `SELECT
         id,
         seq AS sequence,
         "table" AS referenced_resource,
         "from" AS from_column,
         "to" AS referenced_column
       FROM pragma_foreign_key_list(?, 'main')`,
    );

    const snapshots = new Map<string, DatabaseResource>();

    for (const resourceRow of resourceRows) {
      const columnRows = tableXInfoQuery.all(resourceRow.name);
      const primaryKeyRows = columnRows
        .filter((column) => column.primary_key_position > 0)
        .sort(
          (left, right) =>
            left.primary_key_position - right.primary_key_position,
        );

      const integerPrimaryKeyCandidate =
        resourceRow.table_list_type === "table" &&
        resourceRow.without_rowid === 0 &&
        resourceRow.strict === 0 &&
        primaryKeyRows.length === 1 &&
        primaryKeyRows[0]?.declared_type.trim().toUpperCase() === "INTEGER";

      // A true INTEGER PRIMARY KEY aliases rowid and has no separate primary-key
      // index. The index check preserves SQLite's nullable INTEGER PRIMARY KEY
      // DESC exception.
      const hasIntegerPrimaryKeyAlias =
        integerPrimaryKeyCandidate &&
        primaryKeyIndexQuery.get(resourceRow.name) === null;
      const kind =
        resourceRow.table_list_type === "virtual"
          ? "virtual-table"
          : resourceRow.schema_type;
      const writable = kind === "table";

      const columns = Object.freeze(
        columnRows.map((column) => {
          const generated =
            column.hidden === 2
              ? "virtual"
              : column.hidden === 3
                ? "stored"
                : false;

          return Object.freeze({
            cid: column.cid,
            name: column.name,
            declaredType: column.declared_type,
            affinity: getSQLiteAffinity(column.declared_type),
            nullable:
              column.not_null === 0 &&
              !(
                column.primary_key_position > 0 &&
                (resourceRow.without_rowid === 1 ||
                  resourceRow.strict === 1 ||
                  hasIntegerPrimaryKeyAlias)
              ),
            defaultValue: column.default_value,
            primaryKeyPosition:
              column.primary_key_position > 0
                ? column.primary_key_position
                : null,
            generated,
            writable: writable && generated === false,
          } satisfies DatabaseColumn);
        }),
      );

      const primaryKey = Object.freeze(
        primaryKeyRows.map((column) => column.name),
      );
      const resource = {
        name: resourceRow.name,
        kind,
        writable,
        columns,
        primaryKey,
        uniqueConstraints: Object.freeze([]),
        foreignKeys: Object.freeze([]),
      } satisfies DatabaseResource;

      snapshots.set(resource.name, resource);
    }

    const resourcesByIdentifier = new Map(
      [...snapshots.values()].map((resource) => [
        foldSQLiteIdentifier(resource.name),
        resource,
      ]),
    );
    const resources = Object.freeze(
      [...snapshots.values()].map((resource) =>
        Object.freeze({
          ...resource,
          uniqueConstraints: loadUniqueConstraints(
            resource.name,
            resource.primaryKey,
            indexListQuery,
            indexXInfoQuery,
          ),
          foreignKeys: loadForeignKeys(
            resource.name,
            resourcesByIdentifier,
            foreignKeyListQuery,
          ),
        }),
      ),
    );
    const resourcesByName = new Map(
      resources.map((resource) => [resource.name, resource]),
    );

    return Object.freeze({
      getResource(name: string) {
        return resourcesByName.get(name);
      },
      listResources() {
        return resources;
      },
    });
  });

  return readSchema();
}
