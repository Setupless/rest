import type { DatabaseColumn, DatabaseResource } from "../src/database/schema";

function column(
  name: string,
  declaredType: string,
  affinity: DatabaseColumn["affinity"],
  overrides: Partial<DatabaseColumn> = {},
): DatabaseColumn {
  return {
    cid: 0,
    name,
    declaredType,
    affinity,
    nullable: true,
    defaultValue: null,
    primaryKeyPosition: null,
    generated: false,
    writable: true,
    ...overrides,
  };
}

export const FILTER_RESOURCE: DatabaseResource = {
  name: "records",
  kind: "table",
  writable: true,
  columns: [
    column("id", "INTEGER", "integer", {
      cid: 0,
      nullable: false,
      primaryKeyPosition: 1,
    }),
    column("ratio", "REAL", "real", { cid: 1 }),
    column("title", "TEXT", "text", { cid: 2 }),
    column("done", "BOOLEAN", "numeric", { cid: 3 }),
    column("amount", "NUMERIC", "numeric", { cid: 4 }),
    column("bytes", "BLOB", "blob", { cid: 5 }),
    column("payload", "JSON", "numeric", { cid: 6 }),
    column('odd"name', "TEXT", "text", { cid: 7 }),
  ],
  primaryKey: ["id"],
  uniqueConstraints: [{ columns: ["id"], primary: true }],
  foreignKeys: [],
};
