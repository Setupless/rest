import { describe, expect, it } from "bun:test";

import { openDatabase } from "./database";
import {
  buildRelationshipGraph,
  type ColumnMapping,
  type DatabaseRelationshipGraph,
  RelationshipResolutionError,
} from "./relationships";
import { loadDatabaseSchema } from "./schema";

function withRelationshipGraph(
  sql: string,
  assertion: (graph: DatabaseRelationshipGraph) => void,
): void {
  const database = openDatabase({ path: ":memory:", busyTimeoutMs: 0 });

  try {
    database.exec(sql);
    assertion(buildRelationshipGraph(loadDatabaseSchema(database)));
  } finally {
    database.close();
  }
}

describe("buildRelationshipGraph", () => {
  it("creates resolvable direct and inverse relationships", () => {
    withRelationshipGraph(
      `CREATE TABLE authors (id INTEGER PRIMARY KEY);
       CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         author_id INTEGER REFERENCES authors(id)
       );`,
      (graph) => {
        expect(graph.resolve("posts", "authors")).toEqual({
          kind: "direct",
          source: "posts",
          target: "authors",
          cardinality: "many-to-one",
          columnMappings: [{ source: "author_id", target: "id" }],
          hint: "author_id",
        });
        expect(graph.resolve("authors", "posts")).toEqual({
          kind: "inverse",
          source: "authors",
          target: "posts",
          cardinality: "one-to-many",
          columnMappings: [{ source: "id", target: "author_id" }],
          hint: "author_id",
        });

        expect(() => graph.resolve("posts", "authors", "missing_hint")).toThrow(
          expect.objectContaining({
            code: "SLREST202",
            status: 400,
            details:
              'The inferred relationship from resource "posts" to resource "authors" does not match the supplied hint.',
            hint: 'Use relationship hint "author_id".',
          }),
        );
      },
    );
  });

  it("preserves composite foreign-key sequence in both directions", () => {
    withRelationshipGraph(
      `CREATE TABLE organizations (
         tenant TEXT,
         slug TEXT,
         PRIMARY KEY (tenant, slug)
       );
       CREATE TABLE memberships (
         organization_tenant TEXT,
         organization_slug TEXT,
         FOREIGN KEY (organization_tenant, organization_slug)
           REFERENCES organizations(tenant, slug)
      );`,
      (graph) => {
        const direct = graph.resolve("memberships", "organizations");
        const inverse = graph.resolve("organizations", "memberships");

        expect(direct.kind).toBe("direct");
        expect(inverse.kind).toBe("inverse");
        if (direct.kind !== "direct" || inverse.kind !== "inverse") return;

        expect(direct.columnMappings).toEqual([
          { source: "organization_tenant", target: "tenant" },
          { source: "organization_slug", target: "slug" },
        ]);
        expect(inverse.columnMappings).toEqual([
          { source: "tenant", target: "organization_tenant" },
          { source: "slug", target: "organization_slug" },
        ]);
      },
    );
  });

  it("retains both directions of a self-referential foreign key", () => {
    withRelationshipGraph(
      `CREATE TABLE employees (
         id INTEGER PRIMARY KEY,
         manager_id INTEGER REFERENCES employees(id)
       );`,
      (graph) => {
        expect(
          graph.listFrom("employees").map(({ kind, cardinality, hint }) => ({
            kind,
            cardinality,
            hint,
          })),
        ).toEqual([
          {
            kind: "direct",
            cardinality: "many-to-one",
            hint: "manager_id",
          },
          {
            kind: "inverse",
            cardinality: "one-to-many",
            hint: "manager_id",
          },
        ]);
      },
    );
  });

  it("requires a source-column hint for multiple foreign keys to one target", () => {
    withRelationshipGraph(
      `CREATE TABLE addresses (id INTEGER PRIMARY KEY);
       CREATE TABLE orders (
         id INTEGER PRIMARY KEY,
         billing_address_id INTEGER REFERENCES addresses(id),
         shipping_address_id INTEGER REFERENCES addresses(id)
       );`,
      (graph) => {
        expect(() => graph.resolve("orders", "addresses")).toThrow(
          RelationshipResolutionError,
        );

        try {
          graph.resolve("orders", "addresses");
        } catch (error) {
          const relationshipError = error as RelationshipResolutionError;

          expect(error).toMatchObject({
            code: "SLREST203",
            status: 300,
            message: "Multiple Choices",
            details:
              'Multiple inferred relationships exist from resource "orders" to resource "addresses".',
          });
          expect(relationshipError.hint).toContain('"billing_address_id"');
          expect(relationshipError.hint).toContain('"shipping_address_id"');
        }

        expect(
          graph.resolve("orders", "addresses", "billing_address_id"),
        ).toMatchObject({
          kind: "direct",
          hint: "billing_address_id",
          columnMappings: [{ source: "billing_address_id", target: "id" }],
        });
        expect(
          graph.resolve("addresses", "orders", "shipping_address_id"),
        ).toMatchObject({
          kind: "inverse",
          hint: "shipping_address_id",
          columnMappings: [{ source: "id", target: "shipping_address_id" }],
        });

        expect(() =>
          graph.resolve("orders", "addresses", "missing_hint"),
        ).toThrow(
          expect.objectContaining({
            code: "SLREST203",
            hint: expect.stringContaining('"billing_address_id"'),
          }),
        );
      },
    );
  });

  it("creates both traversals through a primary-key junction", () => {
    withRelationshipGraph(
      `CREATE TABLE users (id INTEGER PRIMARY KEY);
       CREATE TABLE roles (id INTEGER PRIMARY KEY);
       CREATE TABLE memberships (
         user_id INTEGER REFERENCES users(id),
         role_id INTEGER REFERENCES roles(id),
         PRIMARY KEY (user_id, role_id)
       );`,
      (graph) => {
        expect(graph.resolve("users", "roles")).toEqual({
          kind: "many-to-many",
          source: "users",
          target: "roles",
          cardinality: "many-to-many",
          hint: "user_id",
          junction: {
            resource: "memberships",
            sourceColumnMappings: [{ source: "id", target: "user_id" }],
            targetColumnMappings: [{ source: "role_id", target: "id" }],
          },
        });
        expect(graph.resolve("roles", "users")).toEqual({
          kind: "many-to-many",
          source: "roles",
          target: "users",
          cardinality: "many-to-many",
          hint: "role_id",
          junction: {
            resource: "memberships",
            sourceColumnMappings: [{ source: "id", target: "role_id" }],
            targetColumnMappings: [{ source: "user_id", target: "id" }],
          },
        });
      },
    );
  });

  it("accepts an unconditional unique junction with composite mappings", () => {
    withRelationshipGraph(
      `CREATE TABLE teams (
         tenant TEXT,
         id INTEGER,
         PRIMARY KEY (tenant, id)
       );
       CREATE TABLE people (id INTEGER PRIMARY KEY);
       CREATE TABLE team_people (
         membership_id INTEGER PRIMARY KEY,
         team_tenant TEXT,
         team_id INTEGER,
         person_id INTEGER REFERENCES people(id),
         FOREIGN KEY (team_tenant, team_id) REFERENCES teams(tenant, id),
         UNIQUE (person_id, team_id, team_tenant)
       );`,
      (graph) => {
        expect(graph.resolve("teams", "people")).toMatchObject({
          kind: "many-to-many",
          hint: "team_tenant,team_id",
          junction: {
            resource: "team_people",
            sourceColumnMappings: [
              { source: "tenant", target: "team_tenant" },
              { source: "id", target: "team_id" },
            ],
            targetColumnMappings: [{ source: "person_id", target: "id" }],
          },
        });
      },
    );
  });

  it("requires exact, unconditional pair uniqueness for junctions", () => {
    withRelationshipGraph(
      `CREATE TABLE users (id INTEGER PRIMARY KEY);
       CREATE TABLE roles (id INTEGER PRIMARY KEY);
       CREATE TABLE loose_memberships (
         user_id INTEGER REFERENCES users(id),
         role_id INTEGER REFERENCES roles(id)
       );
       CREATE TABLE scoped_memberships (
         user_id INTEGER REFERENCES users(id),
         role_id INTEGER REFERENCES roles(id),
         scope TEXT,
         PRIMARY KEY (user_id, role_id, scope)
       );
       CREATE TABLE partial_memberships (
         user_id INTEGER REFERENCES users(id),
         role_id INTEGER REFERENCES roles(id),
         active INTEGER NOT NULL
       );
       CREATE UNIQUE INDEX one_active_membership
         ON partial_memberships (user_id, role_id)
         WHERE active = 1;`,
      (graph) => {
        expect(
          graph.listFrom("users").filter(({ kind }) => kind === "many-to-many"),
        ).toEqual([]);
        expect(() => graph.resolve("users", "roles")).toThrow(
          expect.objectContaining({ code: "SLREST202" }),
        );
      },
    );
  });

  it("does not treat a table with three foreign keys as a junction", () => {
    withRelationshipGraph(
      `CREATE TABLE users (id INTEGER PRIMARY KEY);
       CREATE TABLE roles (id INTEGER PRIMARY KEY);
       CREATE TABLE teams (id INTEGER PRIMARY KEY);
       CREATE TABLE assignments (
         user_id INTEGER REFERENCES users(id),
         role_id INTEGER REFERENCES roles(id),
         team_id INTEGER REFERENCES teams(id),
         UNIQUE (user_id, role_id, team_id)
       );`,
      (graph) => {
        expect(
          graph.listFrom("users").filter(({ kind }) => kind === "many-to-many"),
        ).toEqual([]);
      },
    );
  });

  it("does not infer relationships involving views or virtual tables", () => {
    withRelationshipGraph(
      `CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT);
       CREATE VIEW record_view AS SELECT id FROM records;
       CREATE VIRTUAL TABLE record_search USING fts5(body);
       CREATE TABLE references_to_read_only_resources (
         view_id INTEGER REFERENCES record_view(id),
         search_id INTEGER REFERENCES record_search(rowid)
       );`,
      (graph) => {
        expect(graph.listFrom("record_view")).toEqual([]);
        expect(graph.listFrom("record_search")).toEqual([]);
        expect(graph.listFrom("references_to_read_only_resources")).toEqual([]);
      },
    );
  });

  it("returns safe missing-relation errors without schema implementation data", () => {
    withRelationshipGraph(
      `CREATE TABLE projects (id INTEGER PRIMARY KEY);
       CREATE TABLE tasks (
         id INTEGER PRIMARY KEY,
         project_id INTEGER REFERENCES projects(id)
       );`,
      (graph) => {
        try {
          graph.resolve("tasks", "missing");
          throw Error("Expected relationship resolution to fail");
        } catch (error) {
          expect(error).toMatchObject({
            code: "SLREST202",
            status: 400,
            message: "Relationship not found",
            details:
              'No inferred relationship exists from resource "tasks" to resource "missing".',
            hint: null,
          });

          const publicError = JSON.stringify({
            code: (error as RelationshipResolutionError).code,
            message: (error as Error).message,
            details: (error as RelationshipResolutionError).details,
            hint: (error as RelationshipResolutionError).hint,
          });
          expect(publicError).not.toMatch(
            /CREATE|SELECT|REFERENCES|project_id/,
          );
        }
      },
    );
  });

  it("orders output deterministically and deeply freezes every collection", () => {
    withRelationshipGraph(
      `CREATE TABLE z_targets (id INTEGER PRIMARY KEY);
       CREATE TABLE a_targets (id INTEGER PRIMARY KEY);
       CREATE TABLE sources (
         id INTEGER PRIMARY KEY,
         z_id INTEGER REFERENCES z_targets(id),
         a_id INTEGER REFERENCES a_targets(id)
       );`,
      (graph) => {
        const relationships = graph.listFrom("sources");

        expect(relationships.map(({ target }) => target)).toEqual([
          "a_targets",
          "z_targets",
        ]);
        expect(Object.isFrozen(graph)).toBe(true);
        expect(Object.isFrozen(relationships)).toBe(true);
        expect(Object.isFrozen(relationships[0])).toBe(true);

        const direct = relationships[0];
        expect(direct?.kind).toBe("direct");
        if (direct?.kind !== "direct") return;

        expect(Object.isFrozen(direct.columnMappings)).toBe(true);
        expect(Object.isFrozen(direct.columnMappings[0])).toBe(true);
        expect(() =>
          (direct.columnMappings as ColumnMapping[]).push({
            source: "unsafe",
            target: "unsafe",
          }),
        ).toThrow();
        expect(graph.listFrom("unknown")).toBe(graph.listFrom("unknown"));
        expect(Object.isFrozen(graph.listFrom("unknown"))).toBe(true);
      },
    );
  });

  it("deeply freezes many-to-many junction metadata", () => {
    withRelationshipGraph(
      `CREATE TABLE left_items (id INTEGER PRIMARY KEY);
       CREATE TABLE right_items (id INTEGER PRIMARY KEY);
       CREATE TABLE links (
         left_id INTEGER REFERENCES left_items(id),
         right_id INTEGER REFERENCES right_items(id),
         UNIQUE (left_id, right_id)
       );`,
      (graph) => {
        const relationship = graph.resolve("left_items", "right_items");
        expect(relationship.kind).toBe("many-to-many");
        if (relationship.kind !== "many-to-many") return;

        expect(Object.isFrozen(relationship.junction)).toBe(true);
        expect(
          Object.isFrozen(relationship.junction.sourceColumnMappings),
        ).toBe(true);
        expect(
          Object.isFrozen(relationship.junction.targetColumnMappings),
        ).toBe(true);
        expect(
          Object.isFrozen(relationship.junction.sourceColumnMappings[0]),
        ).toBe(true);
        expect(
          Object.isFrozen(relationship.junction.targetColumnMappings[0]),
        ).toBe(true);
      },
    );
  });
});
