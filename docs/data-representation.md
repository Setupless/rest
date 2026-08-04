# Setupless/rest 0.1 data representation

This document normatively defines conversion between SQLite storage values and
HTTP JSON for Setupless/rest 0.1.x. Conversion is schema-aware, deterministic,
and lossless within this contract. The server must not guess dates, UUIDs,
base64, or PostgreSQL types.

Errors use the registry in [Errors](errors.md). In particular, invalid request
values use `SLREST403`; invalid stored values use `SLREST501` and never expose
the stored value.

## Declared types and precedence

The startup schema preserves the declared type and computes normal SQLite type
affinity. Two exact declared-type overrides are applied before affinity rules:

1. After trimming whitespace and comparing ASCII case-insensitively, exactly
   `BOOLEAN` uses the Boolean contract.
2. After the same normalization, exactly `JSON` uses the JSON contract.

Names such as `BOOL`, `TINYINT(1)`, `JSONB`, `VARCHAR`, and `DATE` do not opt in
to those overrides. They use ordinary SQLite affinity/storage-class behavior.
This narrow rule prevents a later schema or SQLite extension from silently
changing the wire type.

For other declarations, affinity follows SQLite's documented ordered rules:

- a type containing `INT` has INTEGER affinity;
- a type containing `CHAR`, `CLOB`, or `TEXT` has TEXT affinity;
- a type containing `BLOB`, or no declared type, has BLOB affinity;
- a type containing `REAL`, `FLOA`, or `DOUB` has REAL affinity; and
- all remaining declared types have NUMERIC affinity.

The actual SQLite storage class is still authoritative for ordinary columns.
For example, a NUMERIC-affinity column containing SQLite TEXT is returned as a
JSON string; the server does not parse it as a number after the read.

## SQLite-to-JSON rules

| SQLite/schema case | JSON output | Failure |
| --- | --- | --- |
| SQL `NULL` | JSON `null` | Never |
| SQLite TEXT | JSON string with normal JSON escaping | Invalid text decoding is `SLREST501` |
| INTEGER from `-9007199254740991` through `9007199254740991` | JSON number | Never when read exactly |
| INTEGER outside that safe range | Base-10 JSON string, no leading `+` or zeros | Non-integral/unavailable exact value is `SLREST501` |
| SQLite REAL | JSON number | NaN or either infinity is `SLREST501` |
| SQLite BLOB | JSON string `\x` followed by two lowercase hex digits per byte | Non-byte buffer is `SLREST501` |
| Declared BOOLEAN storing integer `0` | JSON `false` | Other storage classes/integers are `SLREST501` |
| Declared BOOLEAN storing integer `1` | JSON `true` | Other storage classes/integers are `SLREST501` |
| Declared JSON storing contract-valid JSON text | Parsed JSON value | Malformed text, unsafe numeric token, or non-TEXT storage is `SLREST501` |

`Number.MAX_SAFE_INTEGER` and `Number.MIN_SAFE_INTEGER` are included in the
number range. The next integers are strings. Negative zero from a REAL is
serialized according to JSON as `0`. JSON object member order stored in a
declared JSON column is not a compatibility guarantee, though the parsed value
is structurally preserved.

### Scalar read example (`representation-scalars`)

Given:

```sql
CREATE TABLE values_example (
  id INTEGER PRIMARY KEY,
  safe_integer INTEGER,
  unsafe_integer INTEGER,
  ratio REAL,
  enabled BOOLEAN,
  payload JSON,
  bytes BLOB,
  note TEXT
);

INSERT INTO values_example VALUES (
  1,
  9007199254740991,
  9007199254740992,
  1.25,
  1,
  '{"tags":["contract"],"approved":true}',
  X'00A5FF',
  'hello'
);
```

The required response is:

```http
GET /values_example?id=eq.1 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

[{"id":1,"safe_integer":9007199254740991,"unsafe_integer":"9007199254740992","ratio":1.25,"enabled":true,"payload":{"tags":["contract"],"approved":true},"bytes":"\\x00a5ff","note":"hello"}]
```

### Null and false example (`representation-null-false`)

```http
GET /values_example?id=eq.2&select=id,enabled,payload,bytes HTTP/1.1

HTTP/1.1 200 OK

[{"id":2,"enabled":false,"payload":null,"bytes":null}]
```

### Controlled stored-data failure (`representation-invalid-json`)

If a declared JSON column contains malformed text, the entire response fails;
the bad cell is never returned as an unparsed string or silently changed to
null:

```http
GET /values_example?id=eq.3 HTTP/1.1

HTTP/1.1 500 Internal Server Error
Content-Type: application/json; charset=utf-8

{"code":"SLREST501","message":"Stored value is invalid","details":"Column \"payload\" on resource \"values_example\" is not valid declared JSON.","hint":"Repair the stored value and retry."}
```

The equivalent rule applies when a declared BOOLEAN stores anything other than
SQLite INTEGER 0 or 1.

## JSON-to-SQLite write rules

The server validates all values before opening or committing a mutation
transaction. It does not perform lossy JavaScript coercion such as `Number(x)`,
truthiness conversion, or stringification of arbitrary objects.

| Target declaration/affinity | Accepted request JSON | SQLite value |
| --- | --- | --- |
| Nullable column | `null` | SQL `NULL` |
| Declared BOOLEAN | JSON `true` or `false` only | INTEGER 1 or 0 |
| Declared JSON | Any contract-valid JSON value, including object, array, string, safe number, Boolean, or null | Compact JSON TEXT produced by the canonical rules below; SQL NULL is used only for JSON `null` when the column is nullable |
| INTEGER affinity | Safe integral JSON number, or canonical base-10 decimal string for any signed 64-bit integer | Exact SQLite INTEGER |
| REAL affinity | Finite JSON number | SQLite REAL |
| TEXT affinity | JSON string | SQLite TEXT |
| BLOB affinity receiving a blob | String `\x` plus an even number of hexadecimal digits | SQLite BLOB bytes |
| NUMERIC affinity | Finite JSON number for REAL, safe integral number/canonical signed-64-bit string for INTEGER, or JSON string for TEXT | Matching lossless SQLite storage class |

For a declared JSON column, JSON `null` maps to SQL NULL when the column is
nullable; there is no 0.1 syntax to store JSON text `"null"` distinctly through
that column. Non-nullable declared JSON therefore rejects JSON `null`.

Declared JSON number validation is recursive across every object member and
array element and occurs against the raw request token before an ordinary
JavaScript parse could round it:

- an integer-valued JSON number must be within
  `-9007199254740991` through `9007199254740991`;
- a non-integer JSON number must parse to a finite IEEE-754 binary64 value;
- clients needing an integer outside the safe range, or exact decimal digits
  beyond binary64 precision, must send a JSON string containing their chosen
  canonical decimal representation; it remains a JSON string; and
- accepted values are stored as compact `JSON.stringify`-equivalent text.
  Whitespace and numeric lexical spelling are not preserved, but the accepted
  JSON value is.

Thus `{"n":9007199254740993}` is `SLREST403`, before it can become
`9007199254740992`. The lossless representation
`{"n":"9007199254740993"}` is accepted and stored exactly as compact text
`{"n":"9007199254740993"}`. Existing declared JSON text containing an unsafe
numeric token is `SLREST501` on read rather than being silently rounded.

```http
POST /values_example HTTP/1.1
Content-Type: application/json

{"id":5,"payload":{"n":9007199254740993}}

HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
X-Request-Id: 01K1EXAMPLE000000000000000

{"code":"SLREST403","message":"Invalid value","details":"Column \"payload\" contains an unsafe JSON integer.","hint":"Represent integers outside the safe range as JSON strings."}
```

A canonical integer string is `0` or `-?[1-9][0-9]*`, contains no whitespace,
decimal point, exponent, or leading plus, and must fit
`-9223372036854775808` through `9223372036854775807`. JSON numbers outside the
safe-integer range are rejected even if mathematically integral because their
input may already be rounded; use a canonical decimal string instead.

BLOB input is case-insensitive for hex digits and is normalized to lowercase on
output. `"\\x"` represents the empty blob. Odd-length hex, a missing prefix,
or a non-string is `SLREST403`. Ordinary TEXT beginning with `\x` is not decoded
unless the target uses BLOB affinity.

SQLite may apply its normal affinity conversion when the accepted value is
bound, but the server must re-read and validate the actual stored post-image
before authorization `check` or `return=representation`.

### Write example (`representation-write`)

```http
POST /values_example HTTP/1.1
Content-Type: application/json
Prefer: return=representation

{"id":4,"safe_integer":42,"unsafe_integer":"9223372036854775807","ratio":2.5,"enabled":false,"payload":{"nested":[1,null]},"bytes":"\\xDeAdBeEf","note":"written"}

HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Preference-Applied: return=representation

[{"id":4,"safe_integer":42,"unsafe_integer":"9223372036854775807","ratio":2.5,"enabled":false,"payload":{"nested":[1,null]},"bytes":"\\xdeadbeef","note":"written"}]
```

### Lossy input rejection (`representation-unsafe-number-input`)

```http
PATCH /values_example?id=eq.4 HTTP/1.1
Content-Type: application/json

{"unsafe_integer":9223372036854775807}

HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"code":"SLREST403","message":"Invalid value","details":"Column \"unsafe_integer\" requires a safe integral JSON number or canonical signed 64-bit decimal string.","hint":"Send the integer as a decimal JSON string."}
```

## Defaults, generated columns, and nullability

- `Prefer: missing=null` is the default for POST and PUT. An omitted writable
  column is treated as SQL NULL and normal nullability constraints apply.
- `Prefer: missing=default` omits the column from SQL so its SQLite default or
  generated behavior runs. Bulk rows must then have a consistent effective
  insert column set.
- Generated virtual/stored columns are present in reads and mutation
  representations but reject direct writes with `SLREST206`.
- A JSON `null` supplied to an ordinary nullable column is SQL NULL. Defaults
  are not substituted for an explicit null.
- SQLite `DEFAULT` expressions and triggers are authoritative. Returned rows
  are re-read post-images, so representations show actual stored results.

```http
POST /tasks HTTP/1.1
Content-Type: application/json
Prefer: missing=default, return=representation

{"id":7,"project_id":10,"title":"Use defaults"}

HTTP/1.1 201 Created
Preference-Applied: return=representation, missing=default

[{"id":7,"project_id":10,"title":"Use defaults","priority":0,"done":false,"metadata":null}]
```

## Object shape and relation values

- Top-level resource reads and mutation representations are arrays unless the
  singular media type was requested.
- Object keys follow `select` order; without `select`, they follow deterministic
  startup schema column order.
- A many-to-one relation is an object or null. One-to-many and many-to-many
  relations are arrays, including an empty array when no authorized children
  match.
- Every embedded scalar uses the same rules in this document.
- Buffers and parsed JSON objects returned by the database are copied or treated
  immutably; serialization never mutates database-returned values.

## Deliberate non-conversions

The following are unsupported in 0.1 and must not be inferred:

- date/time parsing or timezone normalization for TEXT;
- base64 BLOB input/output;
- UUID validation;
- `NaN`, `Infinity`, or `-Infinity` JSON tokens;
- PostgreSQL arrays, ranges, composite values, bytea escape variants, JSON
  path extraction, or numeric special values;
- automatic parsing of JSON stored in columns not declared exactly `JSON`; and
- automatic Boolean conversion for declarations other than exactly `BOOLEAN`.

These choices keep SQLite storage visible and make every 0.1 wire conversion
deterministic.
