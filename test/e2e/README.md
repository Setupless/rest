# Black-box contract traceability

`bun run test:e2e` builds the stock CLI and the programmatic-auth fixture, then
exercises both only through real HTTP child processes. The bracketed IDs below
are stable test-name fragments, so a failing contract claim is directly
searchable in test output.

| Supported compatibility area | Test identifiers |
| --- | --- |
| Collection routes and GET/HEAD/OPTIONS | `read-basic`, `read-head`, `resource-options`, `error-envelope` |
| POST/PATCH/DELETE/PUT and full-table mutations | `insert-single`, `insert-bulk`, `update-filtered`, `update-full-table`, `delete-filtered`, `delete-full-table`, `upsert-post`, `upsert-put` |
| Scalar and Boolean filters | `filter-eq`, `filter-neq`, `filter-gt`, `filter-gte`, `filter-lt`, `filter-lte`, `filter-like`, `filter-ilike`, `filter-in`, `filter-is-null`, `filter-is-boolean`, `filter-not`, `filter-and`, `filter-or`, `filter-not-group` |
| Selection, aliases, order, pagination, range, count, singular media | `select-scalars`, `pagination-query`, `range-items`, `singular-response`, `prefer-mutation-count` |
| Direct, inverse, many-to-many, and nested relations | `select-relations`, `select-many-to-many`, `relation-controls`, `relation-errors`, `auth-relations` |
| Prefer handling, return, count, missing, resolution, max-affected | `prefer-lenient`, `prefer-strict`, `prefer-canonical`, `prefer-mutation-count`, `return-headers-only`, `insert-single`, `upsert-post`, `update-full-table` |
| Writable tables and read-only views | `read-only-resources`, `resource-options` |
| SQLite/JSON value conversion | `data-representation`, `insert-single` |
| Database creation, durability, and startup schema snapshots | `database-creation`, `database-persistence` |
| Stock API key and programmatic plugin authorization | `auth-api-key`, `auth-using`, `auth-check`, `auth-denial`, `auth-relations`, `auth-openapi` |
| OpenAPI root and media negotiation | `openapi-root`, `openapi-negotiation` |
| Stable public errors and transaction rollback | `error-envelope`, `error-media`, `error-constraint`, `error-redaction`, `mutation-atomicity`, `filter-validation`, `relation-errors` |
| Readiness, liveness, CORS, request IDs, body bounds, and logging | `health-readiness`, `health-liveness`, `cors`, `request-id`, `error-body-limit`, `structured-logging` |
| Busy handling and graceful SIGINT/SIGTERM | `database-contention`, `graceful-sigint`, `graceful-sigterm` |

Every server uses a unique temporary directory and ephemeral port unless a
restart test deliberately supplies its own database path. Startup and shutdown
are bounded, output is drained continuously, and owned files are removed even
when a test fails. Diagnostics redact configured credentials before inclusion
in an error.
