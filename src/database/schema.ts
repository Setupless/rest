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
}

interface ColumnRow {
  cid: number;
  name: string;
  declared_type: string;
  not_null: 0 | 1;
  default_value: string | null;
  primary_key_position: number;
}

export interface DatabaseSchema {
  getResource(name: string): DatabaseResource | undefined;
}

export function loadDatabaseSchema(database: Database): DatabaseSchema {
  const readSchema = database.transaction((): DatabaseSchema => {
    const resourceRows = database
      .query<ResourceRow, []>(
        `SELECT name, type
         FROM sqlite_schema
         WHERE type IN ('table', 'view')
           AND name NOT GLOB 'sqlite_*'
         ORDER BY name`,
      )
      .all();

    const tableInfoQuery = database.query<ColumnRow, [string]>(
      `SELECT
             cid,
             name,
             type AS declared_type,
             "notnull" AS not_null,
             dflt_value AS default_value,
             pk AS primary_key_position
           FROM pragma_table_info(?)
           ORDER BY cid`,
    );

    const resources = new Map<string, DatabaseResource>();

    for (const resourceRow of resourceRows) {
      const columnRows = tableInfoQuery.all(resourceRow.name);

      const columns = Object.freeze(
        columnRows.map((column) =>
          Object.freeze({
            name: column.name,
            declaredType: column.declared_type,
            nullable:
              column.not_null === 0 && column.primary_key_position === 0,
            defaultValue: column.default_value,
          } satisfies DatabaseColumn),
        ),
      );

      const primaryKey = Object.freeze(
        columnRows
          .filter((column) => column.primary_key_position > 0)
          .sort(
            (left, right) =>
              left.primary_key_position - right.primary_key_position,
          )
          .map((column) => column.name),
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
