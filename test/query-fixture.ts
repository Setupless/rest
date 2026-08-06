import { buildRelationshipGraph } from "../src/database/relationships";
import type {
  DatabaseColumn,
  DatabaseResource,
  DatabaseSchema,
} from "../src/database/schema";

function column(
  name: string,
  declaredType = "INTEGER",
  affinity: DatabaseColumn["affinity"] = "integer",
): DatabaseColumn {
  return Object.freeze({
    cid: 0,
    name,
    declaredType,
    affinity,
    nullable: true,
    defaultValue: null,
    primaryKeyPosition: null,
    generated: false,
    writable: true,
  });
}

function resource(
  name: string,
  columns: readonly DatabaseColumn[],
  options: Partial<DatabaseResource> = {},
): DatabaseResource {
  return Object.freeze({
    name,
    kind: "table" as const,
    writable: true,
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(["id"]),
    uniqueConstraints: Object.freeze([
      Object.freeze({ columns: Object.freeze(["id"]), primary: true }),
    ]),
    foreignKeys: Object.freeze([]),
    ...options,
  });
}

export const PROJECTS = resource("projects", [
  column("id"),
  column("name", "TEXT", "text"),
]);

export const TASKS = resource(
  "tasks",
  [
    column("id"),
    column("project_id"),
    column("title", "TEXT", "text"),
    column("priority"),
    column("odd.name", "TEXT", "text"),
    column('odd"name', "TEXT", "text"),
  ],
  {
    foreignKeys: Object.freeze([
      Object.freeze({
        id: 0,
        fromColumns: Object.freeze(["project_id"]),
        referencedResource: "projects",
        referencedColumns: Object.freeze(["id"]),
      }),
    ]),
  },
);

export const TAGS = resource("tags", [
  column("id"),
  column("label", "TEXT", "text"),
]);

export const COMPOSITE_PARENTS = resource(
  "composite_parents",
  [column("code", "TEXT", "text"), column("region", "TEXT", "text")],
  {
    primaryKey: Object.freeze(["code", "region"]),
    uniqueConstraints: Object.freeze([
      Object.freeze({
        columns: Object.freeze(["code", "region"]),
        primary: true,
      }),
    ]),
  },
);

export const COMPOSITE_CHILDREN = resource(
  "composite_children",
  [
    column("id"),
    column("parent_code", "TEXT", "text"),
    column("parent_region", "TEXT", "text"),
  ],
  {
    foreignKeys: Object.freeze([
      Object.freeze({
        id: 0,
        fromColumns: Object.freeze(["parent_code", "parent_region"]),
        referencedResource: "composite_parents",
        referencedColumns: Object.freeze(["code", "region"]),
      }),
    ]),
  },
);

export const TASK_TAGS = resource(
  "task_tags",
  [column("task_id"), column("tag_id")],
  {
    primaryKey: Object.freeze(["task_id", "tag_id"]),
    uniqueConstraints: Object.freeze([
      Object.freeze({
        columns: Object.freeze(["task_id", "tag_id"]),
        primary: true,
      }),
    ]),
    foreignKeys: Object.freeze([
      Object.freeze({
        id: 0,
        fromColumns: Object.freeze(["task_id"]),
        referencedResource: "tasks",
        referencedColumns: Object.freeze(["id"]),
      }),
      Object.freeze({
        id: 1,
        fromColumns: Object.freeze(["tag_id"]),
        referencedResource: "tags",
        referencedColumns: Object.freeze(["id"]),
      }),
    ]),
  },
);

export const ADDRESSES = resource("addresses", [column("id")]);
export const ORDERS = resource(
  "orders",
  [column("id"), column("billing_address_id"), column("shipping_address_id")],
  {
    foreignKeys: Object.freeze([
      Object.freeze({
        id: 0,
        fromColumns: Object.freeze(["billing_address_id"]),
        referencedResource: "addresses",
        referencedColumns: Object.freeze(["id"]),
      }),
      Object.freeze({
        id: 1,
        fromColumns: Object.freeze(["shipping_address_id"]),
        referencedResource: "addresses",
        referencedColumns: Object.freeze(["id"]),
      }),
    ]),
  },
);

const resources = Object.freeze([
  ADDRESSES,
  COMPOSITE_CHILDREN,
  COMPOSITE_PARENTS,
  ORDERS,
  PROJECTS,
  TAGS,
  TASKS,
  TASK_TAGS,
]);
const resourcesByName = new Map(
  resources.map((databaseResource) => [
    databaseResource.name,
    databaseResource,
  ]),
);

export const QUERY_SCHEMA: DatabaseSchema = Object.freeze({
  getResource(name: string) {
    return resourcesByName.get(name);
  },
  listResources() {
    return resources;
  },
});

export const QUERY_RELATIONSHIPS = buildRelationshipGraph(QUERY_SCHEMA);
