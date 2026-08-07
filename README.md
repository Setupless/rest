# Setupless/rest

A lightweight, PostgREST-inspired REST API for SQLite, built with Bun and
Elysia.

> [!CAUTION]
> **Setupless/rest is an incomplete, pre-release prototype.** It now exposes
> SQLite reads, recursively embedded relations, and transactional mutations,
> but production hardening is not complete. Do not deploy it or rely on it for
> production workloads.

## Project status

The current prototype can:

- open a local SQLite database;
- inspect complete table, view, column, constraint, and relationship metadata
  at startup;
- serve authorized scalar `GET`, `HEAD`, and `OPTIONS` resource routes with
  filtering, projection, ordering, pagination, counts, and singular responses;
- execute direct, inverse, and conventional many-to-many relation selections
  recursively with independent filtering, pagination, and authorization;
- execute authorized single and bulk `POST` inserts atomically with SQLite
  defaults, trigger-aware post-images, and every documented return mode;
- execute authorized filtered or full-table `PATCH` and `DELETE` mutations with
  deterministic bounded targeting, affected-row guards, and rollback-safe
  policy enforcement;
- execute authorized `POST` conflict resolution and equality-targeted `PUT`
  upserts across primary and unconditional unique constraints;
- serve deterministic, schema-derived OpenAPI 3.1 JSON at `GET /`;
- enforce bounded request bodies and exact-origin CORS with validated
  preflights;
- attach safe request IDs and emit structured, secret-safe completion logs;
- expose database-backed readiness at `GET /health` and process liveness at
  `GET /health/live`; and
- map SQLite contention to retryable `503` responses while retaining
  idempotent, checkpointing shutdown.

It does not yet provide:

- black-box compatibility coverage or release operations documentation; or
- a stable API, configuration format, or compatibility guarantees.

There are no releases yet, and breaking changes should be expected.

The normative target for the 0.1 HTTP surface is now documented. These
documents describe the contract being implemented, not capabilities already
present in this prototype:

- [API compatibility contract](docs/api-compatibility.md)
- [Error envelope and `SLREST` registry](docs/errors.md)
- [SQLite and JSON data representation](docs/data-representation.md)

## Local development

You will need [Bun 1.3.14](https://bun.sh/) to run the project. The required
stable version is recorded in `.bun-version` and is also used by CI.

1. Install dependencies with `bun install`.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_PATH` to a local `.sqlite` or `.db` file and set a non-blank
   `SETUPLESS_REST_API_KEY`. The remaining variables have safe defaults below.
4. Start the development server with `bun run dev`.

To build and run the production bundle:

```sh
bun run build
bun run start
```

The library entrypoint can also be imported without starting a server. Use
`createRestApp` to construct an Elysia application around existing database
dependencies, or `serveRest` to own the complete database and server lifecycle.

### Configuration

`loadConfig` validates the complete environment before startup and returns an
immutable snapshot. Numeric values must be unsigned base-10 integers without
surrounding whitespace.

| Variable | Default and validation |
| --- | --- |
| `DATABASE_PATH` | Required; `:memory:` or a path ending in `.sqlite`/`.db`. Missing files are created only when the parent directory exists. |
| `HOST` | `127.0.0.1`; a hostname or IP address. |
| `PORT` | `3000`; 1–65535. |
| `SETUPLESS_REST_API_KEY` | No default; blank is absent and the stock CLI requires a value before listening. Programmatic configuration may omit it. |
| `MAX_ROWS` | `1000`; 1–1,000,000. Caps root and per-relation pages and the request-wide number of materialized related rows. |
| `MAX_EMBED_DEPTH` | `5`; 0–20. |
| `MAX_BODY_BYTES` | `1048576`; 1–1,073,741,824. |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000`; 0–600,000. |
| `CORS_ORIGINS` | Empty; comma-separated exact HTTP(S) origins, trimmed and deduplicated. Wildcards, credentials, paths, queries, and fragments are rejected. |
| `LOG_LEVEL` | `info`; `debug`, `info`, `warn`, or `error`. |

File databases start in WAL mode with foreign keys and the configured busy
timeout enabled and verified. Startup never creates missing parent directories.

## Checks

Run the automated checks before opening a pull request:

```sh
bun run check
bun run typecheck
bun run test:coverage
bun run build
bun run test:e2e
bun audit
```

The end-to-end command builds `dist/cli.js`, starts it as an isolated child
process against temporary on-disk SQLite databases, and verifies the documented
HTTP and authorization contract over real network requests.

Coverage must remain at or above 85% overall for lines and functions, and at or
above 90% for the query, authentication, schema, and execution modules. Test
fixtures, test files, generated declarations, the type-only auth contract, and
the barrel-only public entrypoint are excluded from those measurements.

Setupless/rest is inspired by PostgREST but is not affiliated with or endorsed
by the PostgREST project.

## License

Setupless/rest is licensed under the [Apache License 2.0](LICENSE).
