import type { DatabaseColumn, DatabaseResource } from "../src/database/schema";

function column(
  name: string,
  declaredType: string,
  affinity: DatabaseColumn["affinity"],
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
  };
}

export const FILTER_RESOURCE: DatabaseResource = {
  name: "records",
  kind: "table",
  writable: true,
  columns: [
    column("id", "INTEGER", "integer"),
    column("ratio", "REAL", "real"),
    column("title", "TEXT", "text"),
    column("done", "BOOLEAN", "numeric"),
    column("amount", "NUMERIC", "numeric"),
    column("bytes", "BLOB", "blob"),
    column("payload", "JSON", "numeric"),
    column('odd"name', "TEXT", "text"),
  ],
  primaryKey: ["id"],
  uniqueConstraints: [{ columns: ["id"], primary: true }],
  foreignKeys: [],
};
