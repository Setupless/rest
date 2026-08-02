import type { Database } from "./database";

export interface DatabaseColumn {
  readonly name: string;
  readonly declaredType: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
}

export interface DatabaseResource {
  readonly name: string;
  readonly type: "table" | "view";
  readonly columns: readonly DatabaseColumn[];
  readonly primaryKey: readonly string[];
}

interface ResourceRow {
  name: string;
  type: DatabaseResource["type"];
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

export interface DatabaseSchema {
  getResource(name: string): DatabaseResource | undefined;
}

export function loadDatabaseSchema(database: Database): DatabaseSchema {
  const readSchema = database.transaction((): DatabaseSchema => {
    const resourceRows = database
      .query<ResourceRow, []>(
        `SELECT
           schema_resource.name,
           schema_resource.type,
           table_metadata.type AS table_list_type,
           table_metadata.wr AS without_rowid,
           table_metadata.strict
         FROM sqlite_schema AS schema_resource
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

    const resources = new Map<string, DatabaseResource>();

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

      const columns = Object.freeze(
        columnRows.map((column) =>
          Object.freeze({
            name: column.name,
            declaredType: column.declared_type,
            nullable:
              column.not_null === 0 &&
              !(
                column.primary_key_position > 0 &&
                (resourceRow.without_rowid === 1 ||
                  resourceRow.strict === 1 ||
                  hasIntegerPrimaryKeyAlias)
              ),
            defaultValue: column.default_value,
          } satisfies DatabaseColumn),
        ),
      );

      const primaryKey = Object.freeze(
        primaryKeyRows.map((column) => column.name),
      );

      const resource = Object.freeze({
        name: resourceRow.name,
        type: resourceRow.type,
        columns,
        primaryKey,
      } satisfies DatabaseResource);

      resources.set(resource.name, resource);
    }

    return Object.freeze({
      getResource(name: string) {
        return resources.get(name);
      },
    });
  });

  return readSchema();
}
