# Setupless/rest 0.1 HTTP compatibility contract

This document is the normative HTTP contract for Setupless/rest 0.1.x. It
describes the API that the 0.1 implementation must provide; it is not a claim
that every behavior is present in the current development build.

The words **must**, **must not**, **should**, and **may** are normative. Example
IDs such as `read-basic` are stable references for implementation and
black-box tests. Error bodies and value conversion are defined in
[Errors](errors.md) and [Data representation](data-representation.md).

Setupless/rest is PostgREST-inspired. It deliberately offers wire compatibility
for common CRUD requests, but it does not claim complete PostgREST behavior or
compatibility with existing Supabase client libraries.

## Example schema and conventions

Most examples use these resources:

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT 0,
  metadata JSON,
  UNIQUE (project_id, title)
);

CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE done = 0;

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id)
);
```

Requests are shown without a host. JSON response examples omit operational
headers such as `X-Request-Id`, but those headers are still required. Resource
names and column names are URL-decoded UTF-8 schema identifiers, not SQL.

## Compatibility classification

Every planned behavior is classified below. **Supported** means required in
0.1.0. **Deferred** means intended after 0.1.0. **Unsupported** means outside
the compatibility contract and must fail rather than be interpreted loosely.

| Area | 0.1 classification | Contract |
| --- | --- | --- |
| Unversioned collection routes, for example `/tasks` | Supported | One decoded resource segment only |
| `GET`, `HEAD`, `OPTIONS` | Supported | Tables, views, and virtual tables |
| `POST`, `PATCH`, `DELETE`, single-row `PUT` | Supported | Writable tables only |
| Full-table `PATCH` and `DELETE` | Supported | An omitted client filter is permitted |
| Scalar filters `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is` | Supported | Schema-validated and parameter-bound |
| Boolean filters `not`, `and`, `or` | Supported | Nested and bounded by `MAX_EMBED_DEPTH` |
| Selection, aliases, order, query pagination, item ranges | Supported | Root and embedded queries |
| Exact counts and singular objects | Supported | `Prefer: count=exact` and vendor media type |
| Single and bulk insert | Supported | One atomic transaction |
| Conflict resolution and `on_conflict` | Supported | PK or unconditional unique constraints |
| Direct, inverse, and conventional many-to-many embedding | Supported | Foreign-key metadata from startup |
| `Prefer` handling, return, count, missing, resolution, max-affected | Supported | Rules are defined below |
| Tables as writable resources | Supported | Generated columns remain read-only |
| Views and virtual tables as read-only resources | Supported | Mutation methods return 405 |
| Missing database-file creation | Supported | Existing parent directory is required |
| Startup schema snapshot | Supported | Schema changes require restart |
| Bearer API key or programmatic authorization plugin | Supported | Fail-closed semantics |
| OpenAPI 3.1 JSON at `/` | Supported | Derived from the startup schema |
| Readiness, liveness, CORS, request IDs, and bounded bodies | Supported | Operational contract below |
| Item routes such as `/tasks/1` | Unsupported | Use `/tasks?id=eq.1` |
| RPC/functions and stored procedure routes | Unsupported | No `/rpc/*` routes |
| PostgreSQL arrays, ranges, FTS, JSON-path filters, casts, `any`/`all` | Unsupported | No equivalent SQLite guessing |
| `!inner`, computed relationships, view relationships, aggregates, arbitrary joins | Unsupported | Embedding is foreign-key based and left-preserving |
| CSV, form, XML, execution-plan, and custom media handlers | Unsupported | JSON only in 0.1 |
| Streaming responses | Deferred | 0.1 buffers bounded JSON results |
| Writable views and virtual tables | Unsupported | Read-only even if SQLite triggers could write them |
| Hot schema/config reload | Unsupported | Restart the process |
| JWT, users/roles, built-in row-policy configuration | Deferred | Supply a programmatic auth plugin instead |
| Dynamic auth-module loading or an external auth service | Deferred | Programmatic dependency injection only |
| JSON Patch, optimistic-lock headers, soft deletion, MERGE endpoints | Deferred | Use documented collection mutations/upserts |
| Server-created parent directories, migrations, or schema management | Unsupported | Database schema remains operator-owned |
| Swagger UI, client code generation, SQL-comment metadata | Deferred | OpenAPI JSON only |
| TLS, rate limiting, metrics, tracing | Deferred | Operate behind suitable infrastructure |
| npm/npx, container, binary, or managed distributions | Deferred | 0.1 is source-based self-hosting |
| Perfect PostgREST/OpenAPI equivalence or Supabase SDK support | Unsupported | Only this document is authoritative |

## General HTTP rules

- Resource routes are unversioned and have exactly one path segment:
  `/{resource}`. A trailing slash and additional segments are not aliases and
  return `SLREST200`.
- `GET /` returns the generated OpenAPI document. `/health` and `/health/live`
  are reserved operational routes and cannot be shadowed by database objects.
- Query parameter names and values use standard percent encoding. Invalid UTF-8
  or percent encoding returns `SLREST100`.
- Controlled failures use exactly `{ code, message, details, hint }`.
- Every response, including errors and preflight responses, contains
  `X-Request-Id`. A valid inbound `X-Request-Id` is echoed; otherwise the server
  generates one. Valid IDs match
  `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; invalid IDs are replaced rather than
  rejected or logged verbatim.
- `/`, `/health`, `/health/live`, and resource `OPTIONS` are intentionally
  unauthenticated so discovery, infrastructure probes, and browser preflight do
  not require a resource operation. Resource `GET`, `HEAD`, and mutation
  methods always use the configured API-key or plugin authorization.
- Resource JSON responses contain `Content-Type: application/json; charset=utf-8`.
  Singular responses use
  `application/vnd.pgrst.object+json; charset=utf-8`.
- Request bodies must use `Content-Type: application/json` with no parameters
  other than `charset=utf-8`. Unsupported request or response media types return
  `SLREST105` (415).
- Absent resource `Accept`, `Accept: */*`, and `Accept: application/json`
  negotiate an array. `application/vnd.pgrst.object+json` negotiates one object.
- All row reads and mutations are transactional. Bulk requests are
  all-or-nothing. Controlled failure never commits a partial mutation.

### Root media negotiation (`openapi-root`)

```http
GET / HTTP/1.1
Accept: application/openapi+json

HTTP/1.1 200 OK
Content-Type: application/openapi+json; charset=utf-8

{"openapi":"3.1.0","info":{"title":"Setupless/rest","version":"0.1.0"},"paths":{"/tasks":{}}}
```

Absent `Accept`, `*/*`, or `application/openapi+json` uses the OpenAPI media
type. `Accept: application/json` returns the same document as
`application/json; charset=utf-8`. The document advertises exactly the methods
available for each startup resource, the supported query/preference syntax,
authentication, the error schema, data representation, and the restart
requirement. Output ordering is deterministic and no secret is included.

## Authentication and authorization

The stock CLI requires `SETUPLESS_REST_API_KEY` and accepts only one header form:

```http
GET /tasks HTTP/1.1
Authorization: Bearer example-api-key

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

[{"id":1,"project_id":10,"title":"Write contract","priority":3,"done":false,"metadata":null}]
```

A missing or malformed bearer header returns `SLREST300`; an incorrect token
returns `SLREST301`. Comparisons are timing-safe and credentials never appear in
responses or logs.

Programmatic startup may supply one `RestAuthPlugin` instead of an API key. The
plugin is authoritative; the server never falls back to the API key after a
plugin denial or failure. It decides `select`, `insert`, `update`, and `delete`
per request and resource:

- `allowed: false` returns 403 by default, or 401 when requested by the plugin.
- `using` is ANDed with client filters for SELECT and UPDATE/DELETE pre-images.
- `check` validates INSERT and UPDATE post-images before commit.
- Missing `using` or `check` is unrestricted only after `allowed: true`.
- Embedded targets and many-to-many junction tables are authorized separately.
- A decision is resolved at most once per request/resource/operation.
- Invalid decisions, invalid filter ASTs, and thrown/rejected plugin calls fail
  closed and disclose no plugin internals.

For example, a `using: { field: "project_id", operator: "eq", value: 10 }`
decision combined with `GET /tasks?priority=gte.2` can only return rows matching
both predicates; the response above is a valid 200 result.

## Reading resources

### GET (`read-basic`)

```http
GET /tasks?order=id.asc HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Range-Unit: items
Content-Range: 0-1/*

[{"id":1,"project_id":10,"title":"Write contract","priority":3,"done":false,"metadata":null},{"id":2,"project_id":10,"title":"Review contract","priority":2,"done":false,"metadata":null}]
```

Without `select`, columns appear in deterministic schema order. Without
`order`, row order is unspecified; clients that need stable pagination must
request an order. Reads use one SQLite read transaction.

### HEAD (`read-head`)

`HEAD` executes the same authorization, filters, count, and pagination plan as
`GET`, and returns the same status and headers with no body:

```http
HEAD /tasks?limit=1 HTTP/1.1

HTTP/1.1 200 OK
Range-Unit: items
Content-Range: 0-0/*
```

### OPTIONS (`resource-options`)

```http
OPTIONS /tasks HTTP/1.1

HTTP/1.1 204 No Content
Allow: GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT
```

For a view or virtual table, `Allow` is `GET, HEAD, OPTIONS`. A configured CORS
preflight additionally returns only the origin, methods, and request headers
permitted by the explicit CORS configuration.

## Filters

Multiple top-level filter parameters are combined with AND. A scalar filter is
`column=operator.value`; `not.` may precede a scalar operator. Boolean groups
use `and=(expression,expression)`, `or=(...)`, and `not=(expression)`, where an
expression is `column.operator.value` or another group. Empty groups are
invalid. Parsing, plugin filters, and SQL compilation use the same immutable
AST; values are always bound parameters.

The examples below all return status 200 and the shown body (assuming the
example rows). They are individual reusable cases.

| ID | Request target | Example response body |
| --- | --- | --- |
| `filter-eq` | `/tasks?id=eq.1` | `[{"id":1,"title":"Write contract"}]` |
| `filter-neq` | `/tasks?id=neq.1&order=id.asc` | `[{"id":2,"title":"Review contract"}]` |
| `filter-gt` | `/tasks?priority=gt.2` | `[{"id":1,"priority":3}]` |
| `filter-gte` | `/tasks?priority=gte.3` | `[{"id":1,"priority":3}]` |
| `filter-lt` | `/tasks?priority=lt.3` | `[{"id":2,"priority":2}]` |
| `filter-lte` | `/tasks?priority=lte.2` | `[{"id":2,"priority":2}]` |
| `filter-like` | `/tasks?title=like.*contract` | `[{"id":1,"title":"Write contract"},{"id":2,"title":"Review contract"}]` |
| `filter-ilike` | `/tasks?title=ilike.write*` | `[{"id":1,"title":"Write contract"}]` |
| `filter-in` | `/tasks?id=in.(1,2)&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-is-null` | `/tasks?metadata=is.null&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-is-boolean` | `/tasks?done=is.false&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-not` | `/tasks?done=not.is.true&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-and` | `/tasks?and=(priority.gte.2,done.is.false)&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-or` | `/tasks?or=(id.eq.1,id.eq.2)&order=id.asc` | `[{"id":1},{"id":2}]` |
| `filter-not-group` | `/tasks?not=(priority.lt.2)&order=id.asc` | `[{"id":1},{"id":2}]` |

`in.(...)` accepts quoted items with commas or reserved characters; backslash
escapes `"` and `\` inside quoted items. For example,
`title=in.("Review contract","Ship, maybe")` returns a normal 200 JSON array.
Unquoted items are trimmed. `like` maps `*` to SQL LIKE `%`; literal `%` and `_`
retain SQLite LIKE meaning. `ilike` uses SQLite's built-in case-insensitive LIKE,
which is ASCII-oriented unless the deployed SQLite build supplies additional
collation behavior. `is` accepts only `null`, `true`, and `false`.

Values are coerced according to schema metadata without lossy conversion.
Unknown columns, malformed values, excessive nesting, duplicate ambiguous
parameters, and invalid operator/type combinations return `SLREST101` or
`SLREST102` before SQL runs.

## Selection, aliases, ordering, and embedding

### Scalar projection (`select-scalars`)

```http
GET /tasks?select=task_id:id,label:title&order=id.asc&limit=1 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

[{"task_id":1,"label":"Write contract"}]
```

`select=*`, comma-separated columns, and `alias:column` are supported. Output
names must be unique. Unknown columns and duplicate output names fail before
execution.

Ordering is `order=column[.asc|.desc][.nullsfirst|.nullslast]`, with comma-
separated terms. Direction defaults to `asc`; SQLite's default null placement
applies when omitted.

```http
GET /tasks?select=id,priority&order=priority.desc.nullslast,id.asc HTTP/1.1

HTTP/1.1 200 OK

[{"id":1,"priority":3},{"id":2,"priority":2}]
```

### Embedded relations (`select-relations`)

Foreign keys create direct many-to-one and inverse one-to-many relations. A
table with exactly two foreign keys whose combined source columns are covered
by its primary key or one unconditional unique constraint also creates a
many-to-many relation. Composite column order is preserved. Views and virtual
tables do not participate in inferred relations.

```http
GET /tasks?select=id,title,project:projects!project_id(id,name)&order=id.asc HTTP/1.1

HTTP/1.1 200 OK

[{"id":1,"title":"Write contract","project":{"id":10,"name":"REST 0.1"}},{"id":2,"title":"Review contract","project":{"id":10,"name":"REST 0.1"}}]
```

Many-to-one is an object or `null`; inverse one-to-many and many-to-many are
arrays. `alias:resource!hint(...)` supplies an output alias and a stable
foreign-key hint. The hint is the comma-separated source FK column list.
Unambiguous relations may omit it.

Embedded controls are prefixed by the relation output name:

```http
GET /projects?select=id,tasks(id,title,priority)&tasks.priority=gte.2&tasks.order=priority.desc&tasks.limit=2 HTTP/1.1

HTTP/1.1 200 OK

[{"id":10,"tasks":[{"id":1,"title":"Write contract","priority":3},{"id":2,"title":"Review contract","priority":2}]}]
```

The qualifying `task_tags` junction exposes a many-to-many `tags` array and
may be nested recursively:

```http
GET /projects?id=eq.10&select=id,tasks(id,title,tags(id,label)) HTTP/1.1

HTTP/1.1 200 OK

[{"id":10,"tasks":[{"id":1,"title":"Write contract","tags":[{"id":20,"label":"docs"}]},{"id":2,"title":"Review contract","tags":[]}]}]
```

Normal embedding is left-preserving: embedded filters do not remove a root
row. Relations are recursively supported through `MAX_EMBED_DEPTH` (default 5),
including cycles below the limit. Every relation page is independently capped
by `MAX_ROWS` (default 1000). Deeper requests return `SLREST110`; absent and
ambiguous relations return `SLREST202` and `SLREST203`.

## Pagination, counts, and singular responses

`limit` is the maximum rows and `offset` is the zero-based start. Both are
non-negative decimal safe integers; limit may be zero. Each requested limit is
clamped to `MAX_ROWS`. Query pagination is used unless a `Range` header exists.

An item range uses an inclusive end:

```http
GET /tasks?order=id.asc HTTP/1.1
Range-Unit: items
Range: 0-0
Prefer: count=exact

HTTP/1.1 206 Partial Content
Range-Unit: items
Content-Range: 0-0/2
Preference-Applied: count=exact

[{"id":1,"title":"Write contract"}]
```

Only `items` is supported. `Range` takes precedence over query `limit` and
`offset`; under `handling=strict`, supplying both is `SLREST103`, while lenient
handling ignores the query pair. Open-ended `Range: 1-` is capped by
`MAX_ROWS`. Negative, reversed, fractional, overflowing, or other units return
`SLREST109` (416). An explicit item range starting beyond a known exact total
returns 416 with `Content-Range: */<total>`; a query offset beyond the end is a
successful empty array.

Resource reads always emit `Range-Unit: items`. `Content-Range` is
`start-end/*` without exact count, `start-end/total` with it, and `*/0` for an
empty exact result. Status is 206 only when `count=exact` proves that the
returned window is a strict subset; otherwise it is 200.

Query pagination produces the same window without an HTTP Range header:

```http
GET /tasks?order=id.asc&limit=1&offset=1 HTTP/1.1

HTTP/1.1 200 OK
Range-Unit: items
Content-Range: 1-1/*

[{"id":2,"project_id":10,"title":"Review contract","priority":2,"done":false,"metadata":null}]
```

Singular media requires exactly one row:

```http
GET /tasks?id=eq.1 HTTP/1.1
Accept: application/vnd.pgrst.object+json

HTTP/1.1 200 OK
Content-Type: application/vnd.pgrst.object+json; charset=utf-8

{"id":1,"project_id":10,"title":"Write contract","priority":3,"done":false,"metadata":null}
```

Zero or multiple rows return `SLREST106` (406); the server never silently picks
a row.

## Mutations

Mutations are available only on writable tables. All payload columns are
resolved before SQL. Unknown, generated, and otherwise non-writable columns are
rejected. Constraint and policy failures roll back the entire request.

### POST insert (`insert-single`, `insert-bulk`)

POST accepts one object or a non-empty array of objects. JSON scalars, `null`,
empty arrays, non-object array members, and inconsistent effective bulk column
sets are invalid.

```http
POST /tasks HTTP/1.1
Content-Type: application/json
Prefer: return=representation

{"id":3,"project_id":10,"title":"Publish contract"}

HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Preference-Applied: return=representation

[{"id":3,"project_id":10,"title":"Publish contract","priority":0,"done":false,"metadata":null}]
```

```http
POST /tasks HTTP/1.1
Content-Type: application/json
Prefer: missing=default, return=minimal

[{"id":4,"project_id":10,"title":"Test examples"},{"id":5,"project_id":10,"title":"Tag release"}]

HTTP/1.1 201 Created
Preference-Applied: return=minimal, missing=default
Content-Length: 0
```

Default `missing=null` treats omitted writable fields as null; this can trigger
a not-null failure. `missing=default` omits them from SQL so SQLite defaults
apply. Bulk rows must have one consistent effective column set after this rule.

`return=minimal` is the mutation default and returns no body.
`return=headers-only` also returns no body and adds `Location` only for a
single logical row with a complete primary key, for example
`Location: /tasks?id=eq.3`. Composite key filters are joined with `&` in schema
order. `return=representation` returns the post-image array after applying the
requested selection.

```http
POST /tasks HTTP/1.1
Content-Type: application/json
Prefer: return=headers-only

{"id":8,"project_id":10,"title":"Link result"}

HTTP/1.1 201 Created
Location: /tasks?id=eq.8
Preference-Applied: return=headers-only
Content-Length: 0
```

Under the default `missing=null`, omitting a required non-null column produces
a controlled constraint response instead of applying its SQLite default:

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"id":9,"project_id":10,"title":"Null default"}

HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"code":"SLREST402","message":"Constraint violation","details":"A NOT NULL constraint on column \"priority\" was violated.","hint":"Provide the column or use missing=default to apply its SQLite default."}
```

### POST conflict resolution (`upsert-post`)

```http
POST /tasks?on_conflict=project_id,title HTTP/1.1
Content-Type: application/json
Prefer: resolution=merge-duplicates, return=representation

{"project_id":10,"title":"Write contract","priority":4}

HTTP/1.1 201 Created
Preference-Applied: return=representation, resolution=merge-duplicates

[{"id":1,"project_id":10,"title":"Write contract","priority":4,"done":false,"metadata":null}]
```

`resolution=merge-duplicates` updates only supplied writable columns;
`resolution=ignore-duplicates` leaves conflicting rows unchanged. Without
`on_conflict`, the complete primary key is the target. `on_conflict` must name
exactly one complete unconditional unique constraint; request order is
normalized to schema order. Partial and expression indexes are invalid.

Bulk upserts are atomic. New rows apply insert `check`; merged rows apply update
`using` to the pre-image and `check` to the post-image. An outcome that cannot
be classified safely fails closed.

Ignoring a duplicate succeeds without returning the existing row as though it
were affected:

```http
POST /tasks HTTP/1.1
Content-Type: application/json
Prefer: resolution=ignore-duplicates, return=representation

{"id":1,"project_id":10,"title":"Ignored duplicate"}

HTTP/1.1 201 Created
Preference-Applied: return=representation, resolution=ignore-duplicates

[]
```

### PATCH (`update-filtered`, `update-full-table`)

PATCH accepts exactly one non-empty object. Filters, authorization `using`,
order, offset, and limit select pre-images. Post-images are re-read for `check`.

```http
PATCH /tasks?id=eq.2 HTTP/1.1
Content-Type: application/json
Prefer: return=representation

{"done":true}

HTTP/1.1 200 OK
Preference-Applied: return=representation

[{"id":2,"project_id":10,"title":"Review contract","priority":2,"done":true,"metadata":null}]
```

An omitted client filter deliberately targets the full authorization-visible
table:

```http
PATCH /tasks HTTP/1.1
Content-Type: application/json
Prefer: max-affected=100, return=minimal

{"priority":0}

HTTP/1.1 204 No Content
Preference-Applied: return=minimal, max-affected=100
```

When mutation `limit` or `offset` is supplied, `order` must contain a complete
PK or unconditional unique constraint so the target set is deterministic.
`max-affected=n` evaluates the actual count and rolls the transaction back if
it is exceeded. Zero affected rows is success.

### DELETE (`delete-filtered`, `delete-full-table`)

```http
DELETE /tasks?done=is.true HTTP/1.1
Prefer: return=representation

HTTP/1.1 200 OK
Preference-Applied: return=representation

[{"id":2,"project_id":10,"title":"Review contract","priority":2,"done":true,"metadata":null}]
```

DELETE uses the same target, deterministic pagination, full-table, return, and
`max-affected` rules as PATCH, but has no post-image `check`. A full-table
delete is explicitly permitted:

```http
DELETE /tasks HTTP/1.1
Prefer: return=minimal

HTTP/1.1 204 No Content
Preference-Applied: return=minimal
```

### Single-row PUT (`upsert-put`)

PUT accepts exactly one object and only equality filters that cover every
primary-key column. It rejects incomplete PK filters, unrelated filters,
limit/offset, URL/body key mismatches, and tables without a primary key. The
body must include the PK and every writable non-null column without a default;
other omitted columns follow the `missing` preference.

```http
PUT /tasks?id=eq.6 HTTP/1.1
Content-Type: application/json
Prefer: missing=default, return=representation

{"id":6,"project_id":10,"title":"Archive contract"}

HTTP/1.1 201 Created
Location: /tasks?id=eq.6
Preference-Applied: return=representation, missing=default

[{"id":6,"project_id":10,"title":"Archive contract","priority":0,"done":false,"metadata":null}]
```

PUT ensures one logical row by inserting or updating on the complete PK and
always returns 201 on success. All POST return modes apply; a complete PK allows
`Location`. Insert and update authorization phases are enforced as applicable.

## Prefer header

Preferences are comma-separated and case-insensitive for names and token
values. The first occurrence of a preference name wins; later duplicates are
ignored deterministically. `handling` is determined before validating the rest
of the header. Defaults are `handling=lenient`, `return=minimal`, and
`missing=null`; no count or conflict resolution is implied.

| Preference | Supported values | Applies to |
| --- | --- | --- |
| `handling` | `lenient`, `strict` | Every request |
| `return` | `minimal`, `headers-only`, `representation` | Mutations |
| `count` | `exact` | GET/HEAD and mutation representation |
| `missing` | `null`, `default` | POST and PUT |
| `resolution` | `merge-duplicates`, `ignore-duplicates` | POST only |
| `max-affected` | Non-negative decimal safe integer | PATCH and DELETE |

Lenient handling ignores unknown or inapplicable preferences. Strict handling
returns `SLREST104` before execution. `Preference-Applied` contains only
recognized preferences actually applied, in canonical table order; requested
values equal to defaults are still included when applicable.

For successful mutations, `count=exact` reports the authorized affected-row
count through `Range-Unit: items` and `Content-Range`, even for a minimal body;
it does not change the mutation's normal 200/201/204 status. A representation
uses `0-(n-1)/n`, while a zero-row mutation uses `*/0`.

Unknown preferences illustrate the handling modes:

```http
GET /tasks?limit=0 HTTP/1.1
Prefer: future-option=yes

HTTP/1.1 200 OK

[]
```

```http
GET /tasks HTTP/1.1
Prefer: handling=strict, future-option=yes

HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"code":"SLREST104","message":"Invalid preference","details":"Preference \"future-option\" is not supported.","hint":"Remove it or use handling=lenient."}
```

```http
GET /tasks?limit=1 HTTP/1.1
Prefer: handling=strict, count=exact

HTTP/1.1 206 Partial Content
Preference-Applied: handling=strict, count=exact
Content-Range: 0-0/2

[{"id":1,"project_id":10,"title":"Write contract","priority":3,"done":false,"metadata":null}]
```

## Resource and schema lifecycle

Ordinary, STRICT, and WITHOUT ROWID tables are writable. Generated columns are
selectable but never writable. Views and virtual tables are read-only and
return `SLREST204` for POST, PATCH, DELETE, or PUT. SQLite internal objects,
virtual-table shadow tables, and temporary-schema collisions are not exposed.

At startup, a missing `.sqlite` or `.db` file is created when its parent
directory exists. Parent directories are never created. The service enables
foreign keys, WAL for file databases, and the configured busy timeout before
listening.

Schema metadata and relationships are one immutable startup snapshot. Creating,
altering, or dropping resources while the service runs does not change the API;
restart the process to refresh it. Request-time PRAGMA/schema discovery is not
part of the contract.

### Configuration bounds

These values are part of the 0.1 runtime contract. Numeric values are base-10
integers with no sign, fraction, exponent, or surrounding whitespace.

| Environment variable | Default/rule |
| --- | --- |
| `DATABASE_PATH` | Required; `:memory:` or a path ending in `.sqlite`/`.db`; an absent file is created but its parent must exist |
| `HOST` | `127.0.0.1`; non-empty hostname/IP text with no scheme, path, whitespace, or control characters |
| `PORT` | `3000`; 1 through 65535 |
| `SETUPLESS_REST_API_KEY` | No default; blank is absent; required by the stock CLI and never echoed |
| `MAX_ROWS` | `1000`; 1 through 1,000,000 |
| `MAX_EMBED_DEPTH` | `5`; 0 through 20; 0 disables relation/Boolean nesting |
| `MAX_BODY_BYTES` | `1048576`; 1 through 1,073,741,824 |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000`; 0 through 600,000 |
| `CORS_ORIGINS` | Empty; comma-separated exact HTTP(S) origins, trimmed/deduplicated; wildcard, path, query, fragment, and credentials are unsupported |
| `LOG_LEVEL` | `info`; one of `debug`, `info`, `warn`, `error` |

Configuration failures occur before listening, name the variable, and do not
echo secrets or sensitive paths. Programmatic startup may omit an API key only
when it supplies an auth plugin.

## Operational HTTP behavior

### Health (`health-readiness`, `health-liveness`)

```http
GET /health HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"status":"ok","database":"ready"}
```

Readiness performs a bounded database probe and returns `SLREST503` with 503
when the database is unavailable. `GET /health/live` performs no database query
and returns `200 {"status":"ok"}` while the process can serve HTTP.

### Limits, CORS, contention, and logging

- Bodies larger than `MAX_BODY_BYTES` (default 1,048,576) are rejected with
  `SLREST108` before JSON parsing, including chunked requests.
- Browser origins receive CORS permission only when listed by `CORS_ORIGINS`.
  Empty configuration permits no cross-origin requests. Denied actual and
  preflight requests return `SLREST305` without an allow-origin header.
- SQLite busy/locked failures return `SLREST502` (503) and `Retry-After: 1`.
- Completion logs contain request ID, method, normalized route, status,
  duration, and `SLREST` code when present. They never contain credentials,
  bodies, filter values, raw query strings, SQL, bound values, or filesystem
  paths.
- Graceful SIGINT/SIGTERM and direct stop are idempotent and checkpoint WAL
  before closing. Shutdown errors set a nonzero CLI exit status.

For an exact allowed origin, responses echo it in
`Access-Control-Allow-Origin` and add `Vary: Origin`; wildcard and credentialed
CORS are never enabled. Preflight permits only the target resource's advertised
methods and these case-insensitive request headers: `Authorization`,
`Content-Type`, `Prefer`, `Range`, `Range-Unit`, and `X-Request-Id`. Browser
responses expose `Content-Range`, `Range-Unit`, `Preference-Applied`,
`Location`, `Retry-After`, and `X-Request-Id`.

```http
OPTIONS /tasks HTTP/1.1
Origin: https://app.example
Access-Control-Request-Method: PATCH
Access-Control-Request-Headers: authorization, content-type, prefer

HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example
Access-Control-Allow-Methods: GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT
Access-Control-Allow-Headers: Authorization, Content-Type, Prefer
Access-Control-Expose-Headers: Content-Range, Range-Unit, Preference-Applied, Location, Retry-After, X-Request-Id
Vary: Origin
```

## Explicit deviations from PostgREST

- SQLite, not PostgreSQL, determines types, constraints, transactions,
  collation, locking, and conflict behavior.
- Routes are collection-only; there are no item or RPC routes.
- Only the filter, selection, relation, preference, and media subsets in this
  document exist. PostgreSQL-specific operators and representations do not.
- Relationship hints use source FK column lists because SQLite does not expose
  reliable constraint names.
- Embedding is left-preserving; `!inner` is not supported.
- Views and virtual tables are read-only in 0.1.
- Counts are exact or absent; planned/estimated counts are not supported.
- The root is deterministic OpenAPI 3.1 JSON, not a byte-compatible PostgREST
  document.
- SQLite `ilike`, BOOLEAN, JSON, INTEGER, and BLOB behavior follows
  [Data representation](data-representation.md).

Features not explicitly marked supported are not implicitly compatible. A
later release may add a deferred feature only by updating this contract and its
black-box tests.
