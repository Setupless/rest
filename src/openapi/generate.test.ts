import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import { buildRelationshipGraph } from "../database/relationships";
import { loadDatabaseSchema } from "../database/schema";
import { generateOpenApi } from "./generate";

const databases: Database[] = [];

function generate(
  sql = "",
  authorizationMode: "api-key" | "none" | "programmatic" = "api-key",
) {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  if (sql) database.run(sql);
  const schema = loadDatabaseSchema(database);
  const relationships = buildRelationshipGraph(schema);
  return generateOpenApi({
    title: "Contract fixture",
    version: "0.1.0-test",
    schema,
    relationships,
    authorizationMode,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function resourceSchema(
  document: Readonly<Record<string, unknown>>,
  title: string,
): Record<string, unknown> {
  const components = record(document.components);
  const schemas = record(components.schemas);
  const match = Object.values(schemas).find(
    (schema) => record(schema).title === title,
  );
  if (match === undefined) throw new Error(`Missing schema ${title}`);
  return record(match);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("generateOpenApi", () => {
  it("validates as OpenAPI 3.1 and remains byte-stable", async () => {
    const sql = `
      CREATE TABLE parents (
        tenant_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE children (
        tenant_id INTEGER NOT NULL,
        parent_id INTEGER NOT NULL,
        label TEXT,
        FOREIGN KEY (tenant_id, parent_id)
          REFERENCES parents (tenant_id, id)
      );
    `;
    const first = generate(sql);
    const second = generate(sql);
    const validation = await new Validator().validate(first);

    expect(validation).toEqual({ valid: true });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.paths)).toBe(true);
  });

  it("advertises exact methods for tables, views, and virtual tables", () => {
    const document = generate(`
      CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIEW record_view AS SELECT id, body FROM records;
      CREATE VIRTUAL TABLE record_search USING fts5(body);
    `);
    const paths = record(document.paths);
    const components = record(document.components);
    const schemas = record(components.schemas);

    expect(Object.keys(record(paths["/records"]))).toEqual([
      "get",
      "head",
      "options",
      "post",
      "patch",
      "delete",
      "put",
    ]);
    expect(Object.keys(record(paths["/record_view"]))).toEqual([
      "get",
      "head",
      "options",
    ]);
    expect(Object.keys(record(paths["/record_search"]))).toEqual([
      "get",
      "head",
      "options",
    ]);
    expect(schemas).toHaveProperty("records");
    expect(schemas).toHaveProperty("SLRESTError");
    expect(record(components.securitySchemes)).toHaveProperty("bearerAuth");
  });

  it("keeps operational routes reserved from schema-resource shadowing", () => {
    const document = generate(
      "CREATE TABLE health (id INTEGER PRIMARY KEY, note TEXT)",
    );
    const health = record(record(document.paths)["/health"]);

    expect(Object.keys(health)).toEqual(["get", "head", "options"]);
    expect(record(document["x-setupless-rest"]).reservedResourceNames).toEqual([
      "health",
    ]);
  });

  it("does not guess a programmatic plugin security scheme", () => {
    const document = generate(
      "CREATE TABLE records (id INTEGER PRIMARY KEY)",
      "programmatic",
    );
    const components = record(document.components);
    const get = record(record(record(document.paths)["/records"]).get);

    expect(components).not.toHaveProperty("securitySchemes");
    expect(get).not.toHaveProperty("security");
    expect(get["x-setupless-rest-authorization"]).toEqual({
      mode: "programmatic",
      credentials: "application-defined",
      openapiSecurityAuthoritative: false,
    });
    expect(document["x-setupless-rest-authorization"]).toMatchObject({
      mode: "programmatic",
      credentials: "application-defined",
      openapiSecurityAuthoritative: false,
    });
  });

  it("encodes hostile resource paths and allocates valid component keys", async () => {
    const document = generate(`
      CREATE TABLE "!odd/table {name}" ("value name" TEXT);
      CREATE TABLE Resource1 (id INTEGER PRIMARY KEY);
      CREATE TABLE SLREST100 (id INTEGER PRIMARY KEY);
    `);
    const paths = record(document.paths);
    const schemas = record(record(document.components).schemas);

    expect(paths).toHaveProperty("/!odd%2Ftable%20%7Bname%7D");
    expect(
      Object.values(schemas).map((schema) => record(schema).title),
    ).toContain("!odd/table {name}");
    expect(await new Validator().validate(document)).toEqual({ valid: true });
  });

  it("describes every representation, composite identity, and relationship", () => {
    const document = generate(`
      CREATE TABLE accounts (
        tenant_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE values_example (
        tenant_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        enabled BOOLEAN,
        payload JSON,
        required_payload JSON NOT NULL,
        count INTEGER,
        ratio REAL,
        note TEXT,
        bytes BLOB,
        amount NUMERIC,
        generated_note TEXT GENERATED ALWAYS AS (note || id) STORED,
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id, id) REFERENCES accounts (tenant_id, id)
      ) WITHOUT ROWID;
    `);
    const row = resourceSchema(document, "values_example");
    const properties = record(row.properties);
    const insert = resourceSchema(document, "values_example insert");
    const insertProperties = record(insert.properties);
    const replace = resourceSchema(document, "values_example replacement");
    const paths = record(document.paths);
    const resourcePath = record(paths["/values_example"]);
    const get = record(resourcePath.get);
    const put = record(resourcePath.put);
    const putParameters = (put.parameters as unknown[]).map(record);

    expect(row["x-setupless-primary-key"]).toEqual(["tenant_id", "id"]);
    expect(replace.required).toEqual(["tenant_id", "id", "required_payload"]);
    expect(record(properties.enabled).type).toEqual(["boolean", "null"]);
    expect(record(properties.payload)).not.toHaveProperty("type");
    expect(record(insertProperties.required_payload)).toMatchObject({
      not: { type: "null" },
    });
    expect(record(properties.count).type).toEqual(["number", "string", "null"]);
    expect(record(properties.ratio).type).toEqual(["number", "string", "null"]);
    expect(record(properties.note).type).toEqual(["string", "null"]);
    expect(record(properties.bytes).type).toEqual(["number", "string", "null"]);
    expect(record(properties.amount).type).toEqual([
      "number",
      "string",
      "null",
    ]);
    expect(record(properties.generated_note)["x-setupless-writable"]).toBe(
      false,
    );
    expect(get["x-setupless-relationships"]).toEqual([
      expect.objectContaining({
        target: "accounts",
        hint: "tenant_id,id",
        cardinality: "many-to-one",
        syntax: "accounts!tenant_id,id(*)",
      }),
    ]);
    expect(
      putParameters.map((parameter) => parameter.name).filter(Boolean),
    ).toEqual(["tenant_id", "id"]);
    expect(
      putParameters.some(
        (parameter) => parameter.$ref === "#/components/parameters/Order",
      ),
    ).toBe(false);
  });

  it("generates a valid empty-database document without resource paths", async () => {
    const document = generate("", "none");
    const paths = record(document.paths);
    const schemas = record(record(document.components).schemas);

    expect(Object.keys(paths)).toEqual(["/", "/health", "/health/live"]);
    expect(
      Object.keys(schemas).some((name) => name.startsWith("Resource")),
    ).toBe(false);
    expect(await new Validator().validate(document)).toEqual({ valid: true });
  });

  it("matches the reviewed deterministic document snapshot", () => {
    const document = generate(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        archived BOOLEAN DEFAULT 0
      );
    `);
    const paths = record(document.paths);
    const components = record(document.components);
    const schemas = record(components.schemas);
    const noteSchemas = Object.fromEntries(
      Object.entries(schemas).filter(([, schema]) =>
        String(record(schema).title ?? "").startsWith("notes"),
      ),
    );

    expect({
      openapi: document.openapi,
      jsonSchemaDialect: document.jsonSchemaDialect,
      info: document.info,
      pathMethods: Object.fromEntries(
        Object.entries(paths).map(([path, item]) => [
          path,
          Object.keys(record(item)),
        ]),
      ),
      noteSchemas,
      errorSchemas: Object.keys(schemas).filter((name) =>
        name.startsWith("SLREST"),
      ),
      authorization: document["x-setupless-rest-authorization"],
      compatibility: document["x-setupless-rest"],
    }).toMatchSnapshot();
  });
});
