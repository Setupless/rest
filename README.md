# Setupless/rest

A lightweight, PostgREST-inspired REST API for SQLite, built with Bun and
Elysia.

> [!CAUTION]
> **Setupless/rest is an incomplete, pre-release prototype.** It does not yet
> expose SQLite data through a REST API. The only HTTP endpoint currently
> implemented is `GET /health`. Do not deploy it or rely on it for production
> workloads.

## Project status

The current prototype can:

- open a local SQLite database;
- inspect its tables, views, columns, and primary keys at startup; and
- serve a health check at `GET /health`.

It does not yet provide:

- REST endpoints for reading or modifying database resources;
- filtering, pagination, relationships, or schema-driven validation;
- authentication, authorization, or production security controls; or
- a stable API, configuration format, or compatibility guarantees.

There are no releases yet, and breaking changes should be expected.

The normative target for the 0.1 HTTP surface is now documented. These
documents describe the contract being implemented, not capabilities already
present in this prototype:

- [API compatibility contract](docs/api-compatibility.md)
- [Error envelope and `SLREST` registry](docs/errors.md)
- [SQLite and JSON data representation](docs/data-representation.md)

## Local development

You will need [Bun](https://bun.sh/) to run the project.

1. Install dependencies with `bun install`.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_PATH` to a local `.sqlite` or `.db` file. `PORT` is optional
   and defaults to `3000`.
4. Start the development server with `bun run dev`.

To build and run the production bundle:

```sh
bun run build
bun run start
```

The library entrypoint can also be imported without starting a server. Use
`createRestApp` to construct an Elysia application around existing database
dependencies, or `serveRest` to own the complete database and server lifecycle.

## Checks

Run the automated checks before opening a pull request:

```sh
bun run check
bun run typecheck
bun test
```

Setupless/rest is inspired by PostgREST but is not affiliated with or endorsed
by the PostgREST project.

## License

Setupless/rest is licensed under the [Apache License 2.0](LICENSE).
