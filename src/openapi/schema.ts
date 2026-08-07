import type { DatabaseColumn, DatabaseResource } from "../database/schema";

export type OpenApiObject = Readonly<Record<string, unknown>>;

const SAFE_INTEGER_MINIMUM = Number.MIN_SAFE_INTEGER;
const SAFE_INTEGER_MAXIMUM = Number.MAX_SAFE_INTEGER;
const SIGNED_64_BIT_PATTERN = "^-?(?:0|[1-9][0-9]{0,18})$";
const BLOB_PATTERN = "^\\\\x(?:[0-9A-Fa-f]{2})*$";

function normalizedDeclaredType(column: DatabaseColumn): string {
  return column.declaredType.trim().toUpperCase();
}

function withNullability(
  schema: Record<string, unknown>,
  nullable: boolean,
): OpenApiObject {
  if (!nullable || Object.keys(schema).length === 0) return schema;

  const type = schema.type;
  if (typeof type === "string") {
    return { ...schema, type: [type, "null"] };
  }
  if (Array.isArray(type)) {
    return { ...schema, type: [...type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function columnDescription(column: DatabaseColumn): string {
  const declaration = column.declaredType.trim() || "no declared type";
  const traits = [
    `SQLite declaration: ${declaration}.`,
    `Affinity: ${column.affinity}.`,
    column.nullable ? "Nullable." : "Not null.",
  ];
  if (column.primaryKeyPosition !== null) {
    traits.push(`Primary-key position ${column.primaryKeyPosition}.`);
  }
  if (column.generated !== false) {
    traits.push(`Generated ${column.generated} column; read-only.`);
  } else if (!column.writable) {
    traits.push("Read-only column.");
  }
  return traits.join(" ");
}

function readValueSchema(column: DatabaseColumn): Record<string, unknown> {
  const declaredType = normalizedDeclaredType(column);
  if (declaredType === "BOOLEAN") return { type: "boolean" };
  if (declaredType === "JSON") return {};
  if (column.affinity === "text") return { type: "string" };

  // SQLite storage classes remain authoritative for ordinary declarations.
  // Numeric storage serializes as a number (or an exact integer string), while
  // TEXT/BLOB storage serializes as a string.
  return { type: ["number", "string"] };
}

function writeValueSchema(column: DatabaseColumn): Record<string, unknown> {
  const declaredType = normalizedDeclaredType(column);
  if (declaredType === "BOOLEAN") return { type: "boolean" };
  if (declaredType === "JSON") {
    return column.nullable ? {} : { not: { type: "null" } };
  }

  switch (column.affinity) {
    case "integer":
      return {
        anyOf: [
          {
            type: "integer",
            minimum: SAFE_INTEGER_MINIMUM,
            maximum: SAFE_INTEGER_MAXIMUM,
          },
          {
            type: "string",
            pattern: SIGNED_64_BIT_PATTERN,
            description:
              "Canonical signed 64-bit decimal string; exact range is enforced at runtime.",
          },
        ],
      };
    case "real":
      return { type: "number" };
    case "text":
      return { type: "string" };
    case "blob":
      return { type: "string", pattern: BLOB_PATTERN };
    case "numeric":
      return {
        anyOf: [{ type: "number" }, { type: "string" }],
      };
  }
}

/** Builds the response representation for one startup-schema column. */
export function createReadColumnSchema(column: DatabaseColumn): OpenApiObject {
  return {
    ...withNullability(readValueSchema(column), column.nullable),
    description: columnDescription(column),
    "x-sqlite-affinity": column.affinity,
    "x-sqlite-declared-type": column.declaredType,
    "x-setupless-generated": column.generated,
    "x-setupless-writable": column.writable,
  };
}

/** Builds the accepted JSON representation for one writable column. */
export function createWriteColumnSchema(column: DatabaseColumn): OpenApiObject {
  return {
    ...withNullability(writeValueSchema(column), column.nullable),
    description: columnDescription(column),
    "x-sqlite-affinity": column.affinity,
    "x-sqlite-declared-type": column.declaredType,
  };
}

function writableProperties(
  resource: DatabaseResource,
): Readonly<Record<string, OpenApiObject>> {
  return Object.fromEntries(
    resource.columns
      .filter((column) => column.writable)
      .map((column) => [column.name, createWriteColumnSchema(column)]),
  );
}

/** Returns the full set of reusable schemas for one exposed resource. */
export function createResourceSchemas(resource: DatabaseResource): Readonly<{
  row: OpenApiObject;
  insert: OpenApiObject;
  patch: OpenApiObject;
  replace: OpenApiObject;
}> {
  const properties = Object.fromEntries(
    resource.columns.map((column) => [
      column.name,
      createReadColumnSchema(column),
    ]),
  );
  const inputProperties = writableProperties(resource);
  const replacementRequired = resource.columns
    .filter(
      (column) =>
        column.writable &&
        (column.primaryKeyPosition !== null ||
          (!column.nullable && column.defaultValue === null)),
    )
    .map((column) => column.name);

  const metadata = {
    "x-sqlite-resource-kind": resource.kind,
    "x-setupless-primary-key": resource.primaryKey,
    "x-setupless-unique-constraints": resource.uniqueConstraints.map(
      (constraint) => ({
        columns: constraint.columns,
        primary: constraint.primary,
      }),
    ),
  };

  return {
    row: {
      title: resource.name,
      type: "object",
      properties,
      // Aliases and embedded relations can add schema-resolved output names.
      additionalProperties: true,
      ...metadata,
    },
    insert: {
      title: `${resource.name} insert`,
      type: "object",
      properties: inputProperties,
      additionalProperties: false,
      ...metadata,
    },
    patch: {
      title: `${resource.name} patch`,
      type: "object",
      properties: inputProperties,
      additionalProperties: false,
      minProperties: 1,
      ...metadata,
    },
    replace: {
      title: `${resource.name} replacement`,
      type: "object",
      properties: inputProperties,
      additionalProperties: false,
      ...(replacementRequired.length === 0
        ? {}
        : { required: replacementRequired }),
      ...metadata,
    },
  };
}
