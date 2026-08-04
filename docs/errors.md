# Setupless/rest 0.1 errors

This document is the complete controlled-error registry for Setupless/rest
0.1.x. Implementations must not add a new `SLREST` code or change a listed HTTP
status without changing this contract and its compatibility tests.

## Envelope and headers

Every controlled HTTP failure has exactly four JSON properties, including null
properties:

```json
{
  "code": "SLREST101",
  "message": "Unknown column",
  "details": "Column \"missing\" does not exist on resource \"tasks\".",
  "hint": null
}
```

The response uses `Content-Type: application/json; charset=utf-8`,
`Cache-Control: no-store`, and `X-Request-Id`. It must not contain extra debug
properties. Special statuses add these headers:

| Status/condition | Required header |
| --- | --- |
| 401 | `WWW-Authenticate: Bearer` |
| 405 | `Allow` with methods available to that resource |
| 416 with known exact total | `Content-Range: */<total>` |
| `SLREST502` | `Retry-After: 1` |

`message` is a stable, human-readable category. `details` identifies safe
request input when useful. `hint` contains a safe corrective action. Clients
must branch on `code`, not prose.

## Information-disclosure rules

Error responses must never disclose:

- SQL text, fragments, bound values, SQLite extended messages, or query plans;
- database or working-directory paths;
- authorization headers, API keys, environment values, or plugin internals;
- request bodies, filter values, raw URLs/query strings, stack traces, or
  exception class names; or
- row data hidden by authorization.

It is safe to disclose a schema-resolved public resource/column name supplied
by the client, a supported token list, a configured numeric public limit, or
relationship hints that the same authorized schema exposes. Authentication and
authorization failures do not reveal whether a filtered row exists. Unexpected
values must be logged only under the same redaction policy; the request ID is
the client/operator correlation mechanism.

## Registry

The “Safe disclosure” column is exhaustive for non-null `details` and `hint`.
Anything else is replaced by the default message and null fields.

| Code | HTTP | Default message | Trigger | Safe disclosure |
| --- | ---: | --- | --- | --- |
| `SLREST100` | 400 | Malformed request | Invalid percent encoding, UTF-8, header syntax, duplicated ambiguous query control, or otherwise unparseable HTTP input | Name of the malformed header/query key and grammar summary; never its sensitive value |
| `SLREST101` | 400 | Unknown column | A filter, selection, order, payload, or conflict parameter names a column absent from the resolved resource | Public resource and column names |
| `SLREST102` | 400 | Invalid filter | Unknown operator, empty Boolean group, malformed `in`, invalid scalar/type pairing, excessive Boolean nesting, or invalid programmatic filter AST | Operator/column and expected public grammar; omit filter values |
| `SLREST103` | 400 | Invalid query controls | Invalid select/alias/order/limit/offset, duplicate output name, contradictory Range and query pagination under strict handling, or unsupported nested control | Offending control name, public limit, and expected grammar |
| `SLREST104` | 400 | Invalid preference | Unknown, malformed, or inapplicable preference while `handling=strict` is effective | Preference name and supported values; omit sensitive values |
| `SLREST105` | 415 | Unsupported media type | Unsupported or malformed request `Content-Type` or response `Accept` | Received media-type token and supported media types |
| `SLREST106` | 406 | Singular result required | Singular media was requested but the authorized query returned zero or more than one row | Actual authorized row count only (`0` or `more than one`), never row data |
| `SLREST107` | 400 | Invalid JSON payload | Malformed JSON, disallowed JSON shape, empty PATCH object, empty bulk array, inconsistent bulk columns, or non-object array member | Expected top-level shape and zero-based member index; never body contents |
| `SLREST108` | 413 | Request body too large | Decoded request body exceeds `MAX_BODY_BYTES`, including streamed/chunked input | Configured byte limit only |
| `SLREST109` | 416 | Invalid item range | Unsupported range unit, negative/fractional/overflowing/reversed range, or explicit start beyond a known total | Expected `items` syntax and exact total when already authorized and counted |
| `SLREST110` | 400 | Maximum relation depth exceeded | Selection or Boolean nesting exceeds `MAX_EMBED_DEPTH` | Configured depth only |
| `SLREST111` | 400 | Maximum affected rows exceeded | Actual PATCH/DELETE count exceeds `Prefer: max-affected`; the transaction is rolled back | Requested maximum and authorized affected count |
| `SLREST112` | 400 | Invalid PUT identity | PUT lacks a complete equality-filtered PK, includes other controls, has a URL/body mismatch, targets a table without a PK, or omits a required column | Public PK/required column names; never values |
| `SLREST113` | 400 | Invalid conflict target | Default PK is unavailable or `on_conflict` does not exactly match an unconditional PK/unique constraint | Public candidate column sets |
| `SLREST200` | 404 | Resource not found | Unknown/internal resource, extra path segment, trailing-slash alias, item route, or unsupported RPC route | Requested public path segment only; do not reveal hidden resources |
| `SLREST202` | 400 | Relationship not found | Selected source/target has no inferred direct, inverse, or many-to-many relationship | Authorized source and target names |
| `SLREST203` | 300 | Multiple Choices | More than one inferred relationship matches and no valid hint disambiguates it | Authorized source/target names and available FK-column hints |
| `SLREST204` | 405 | Method not allowed | Method is not supported, or a mutation targets a view/virtual table | Public resource kind and `Allow` methods |
| `SLREST206` | 400 | Column is not writable | Payload names a generated, hidden, or otherwise read-only column | Public resource and column names |
| `SLREST207` | 400 | Mutation order is not deterministic | Mutation limit/offset lacks an order containing a complete unconditional unique constraint | Public required unique column sets |
| `SLREST300` | 401 | Bearer credentials required | Stock API-key mode receives no header, a non-Bearer scheme, multiple credentials, or malformed Bearer syntax | Expected `Authorization: Bearer <token>` only |
| `SLREST301` | 401 | Invalid bearer credentials | A syntactically valid Bearer token does not match | No details or hint that distinguishes keys |
| `SLREST302` | 401 | Authorization required | Programmatic plugin denies with status 401 | No resource existence or policy details |
| `SLREST303` | 403 | Operation forbidden | Programmatic plugin denies with default/status 403 | Operation and already-public resource name only |
| `SLREST304` | 500 | Authorization failed safely | Plugin throws/rejects, returns an invalid decision, or supplies an invalid policy filter | Null details/hint; plugin data appears only in redacted operator logs |
| `SLREST305` | 403 | Cross-origin request forbidden | Browser origin, method, or requested header is not permitted by `CORS_ORIGINS` | No configured origin list; generic configuration hint only |
| `SLREST400` | 409 | Unique constraint conflict | INSERT/UPDATE conflicts with a primary or unconditional unique constraint without applicable resolution | Public constraint column set when deterministically known; no stored values |
| `SLREST401` | 409 | Foreign key conflict | INSERT/UPDATE references a missing row, or DELETE/UPDATE is referenced | Public local/referenced resource and column names only |
| `SLREST402` | 400 | Constraint violation | NOT NULL, CHECK, STRICT typing, or another non-unique/non-FK data constraint rejects a write | Public column/constraint category when deterministically mapped; no SQLite message |
| `SLREST403` | 400 | Invalid value | Request JSON cannot be converted losslessly for the declared column representation | Public column and expected representation; never submitted value |
| `SLREST405` | 403 | New row violates authorization | INSERT or UPDATE post-image fails plugin `check`; transaction is rolled back | Operation only; no row or predicate data |
| `SLREST406` | 409 | Stored row identity is not stable | A trigger or table shape prevents safe post-image identification/re-read required for authorization or representation | Public resource name and corrective schema hint only |
| `SLREST500` | 500 | Internal server error | Any unexpected, unmapped exception | Null details; hint contains only the request ID support instruction |
| `SLREST501` | 500 | Stored value is invalid | Declared BOOLEAN stores other than integer 0/1, declared JSON is malformed, REAL is non-finite, or a database value cannot satisfy its declared serializer | Public resource/column and representation category; never stored value |
| `SLREST502` | 503 | Database is busy | SQLite busy/locked occurs within the configured timeout | Generic retry hint and `Retry-After`; no lock owner/SQL |
| `SLREST503` | 503 | Database is unavailable | Readiness probe or request cannot access an open, usable database for a non-contention reason | Generic operator hint and request ID; no path/SQLite message |
| `SLREST504` | 500 | Response serialization failed | An otherwise controlled row/result cannot be encoded as finite JSON and no more specific stored-value code applies | Public resource/column when known; no values |

The number gap at `SLREST201` and gaps elsewhere are reserved; reserved codes
must not be emitted in 0.1.

## Canonical examples

### Query error (`error-query`)

```http
GET /tasks?missing=eq.1 HTTP/1.1

HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Request-Id: 01K1EXAMPLE000000000000000

{"code":"SLREST101","message":"Unknown column","details":"Column \"missing\" does not exist on resource \"tasks\".","hint":null}
```

### Singular error (`error-singular`)

```http
GET /tasks?done=is.false HTTP/1.1
Accept: application/vnd.pgrst.object+json

HTTP/1.1 406 Not Acceptable
Content-Type: application/json; charset=utf-8

{"code":"SLREST106","message":"Singular result required","details":"The authorized query returned more than one row.","hint":"Refine the query so it returns exactly one row."}
```

### Authentication error (`error-auth`)

```http
GET /tasks HTTP/1.1

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json; charset=utf-8

{"code":"SLREST300","message":"Bearer credentials required","details":null,"hint":"Send one Authorization: Bearer <token> header."}
```

### Constraint error (`error-constraint`)

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"id":1,"project_id":10,"title":"Duplicate"}

HTTP/1.1 409 Conflict
Content-Type: application/json; charset=utf-8

{"code":"SLREST400","message":"Unique constraint conflict","details":"A unique constraint on (id) was violated.","hint":"Use a different key or an applicable resolution preference."}
```

### Busy error (`error-busy`)

```http
PATCH /tasks?id=eq.1 HTTP/1.1
Content-Type: application/json

{"priority":4}

HTTP/1.1 503 Service Unavailable
Retry-After: 1
Content-Type: application/json; charset=utf-8

{"code":"SLREST502","message":"Database is busy","details":null,"hint":"Retry the request after the indicated delay."}
```

### Unexpected error (`error-unexpected`)

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json; charset=utf-8
X-Request-Id: 01K1EXAMPLE000000000000000

{"code":"SLREST500","message":"Internal server error","details":null,"hint":"Contact the operator with request ID 01K1EXAMPLE000000000000000."}
```

Startup/configuration failures occur before listening and therefore do not use
an HTTP envelope. They must still identify only the invalid environment
variable or public configuration rule and must never echo secrets or filesystem
paths containing sensitive data.
