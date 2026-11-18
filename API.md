# TapeDB API

This is the public API of TapeDB and what it promises. It is the reference;
[README.md](README.md) is the tour.

## Stability

Every part of the API is in one of three states:

- **Stable.** Changes only in a major release, except to fix a bug or a
  security problem. Additions (new optional options, new exports, new error
  codes) may arrive in a minor release.
- **Experimental.** Marked `@experimental` in the types and below. Works and
  is tested, but its shape may change in a minor release, with a CHANGELOG
  entry.
- **Internal.** Everything not listed here. Not exported; may change at any
  time.

Before 1.0, a breaking change to a stable part bumps the minor version
(0.x → 0.x+1) and is listed in the CHANGELOG under "Breaking".

The surface is checked: `test/api-surface.test.ts` compares every export,
every signature (including the types those signatures use), the CLI usage and
the set of error codes against [api/surface.json](api/surface.json), and fails
on any difference. A deliberate change updates this file and the CHANGELOG,
then records the new surface with `bun run api:update`.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@tapedb/tapedb` | browser, Node, Workers | the client, schema builders, ids, roles |
| `@tapedb/tapedb/schema` | anywhere | only what a schema file needs |
| `@tapedb/tapedb/react` | browser (React 19 peer) | hooks |
| `@tapedb/tapedb/worker` | Cloudflare Workers | `defineTapeDB` and claim helpers |
| `@tapedb/tapedb/studio` | Cloudflare Workers | `studio`: the studio at `/_tapedb/studio`, for `defineTapeDB({ studio })` |
| `@tapedb/tapedb/seed` | Node (the CLI) | `defineSeeder`, `runSeeder` and the seeding context |
| `npx tapedb-cli` | Node 22.18+ | the CLI, a separate package that runs the matching `@tapedb/tapedb` |

`@tapedb/tapedb` has no runtime dependencies and never imports React.

## `@tapedb/tapedb/schema` — stable

`schema`, `model`, `t` (field builders), `role`, `filter`, `check`,
`fileCheck`, `attachedTo`, and the types `Schema`, `Row`, `Where`,
`FieldFilter`, `OrderBy`, `Include`, `CreateData`, `UpdateData`,
`DeleteBehaviour`, `ScalarKind`, `Access`, `AccessAuth`, `CheckContext`,
`FileAccess`, `FileCheckContext`, `FileInfo`.

`schema(models, { files? })`: `files` is `{ read?, write?, delete? }`, each a
`role(...)`, `fileCheck(({ auth, file, existing }) => boolean)` or
`attachedTo(model, (path) => id | null)`. `file` is a `FileInfo`
(`{ path, size, contentType, uploadedBy }`, `uploadedBy` the uploader's claim subject; for a write, the incoming file,
and `existing` the one it replaces). `attachedTo` reads need the row readable
by the caller; writes and deletes need the caller allowed to update it. Defaults:
read `member`, write and delete `editor`. A rule that throws denies.

Literal `schema()` definitions are checked by TypeScript: relation targets must
exist, each `hasMany` must resolve to exactly one matching `belongsTo` (or name
its `inverse`), and personal subjects must be `self`, an existing non-personal
string field, or a generated belongs-to foreign key. Diagnostics identify the
model and field. Widened or dynamically built definitions still use runtime
validation. These checks do not change runtime behavior.

## `@tapedb/tapedb` — client

Everything in `@tapedb/tapedb/schema`, plus:

**`createClient({ schema, url, workspace, userId?, getToken?, onWriteRejected? })`** →
`Client`. Without `getToken` the client asks the development claim route for a
token, which only `tapedb dev` (or a gated test Worker) serves. Browser clients
using the default IndexedDB outbox must supply `userId` matching the claim subject
(`dev-user` in development). Close and recreate clients on account changes;
legacy unscoped queues are retained but never automatically replayed.

Per model, `db.<model>` is a `ModelClient`:

| Method | Returns | |
| --- | --- | --- |
| `findMany(args?)` | `Query<Row[]>` | `where`, `orderBy`, `take`, `skip`, `include`, `select`; no `take` reads all rows |
| `findFirst(args?)` | `Query<Row \| null>` | |
| `findUnique({ where: { id }, include?, select? })` | `Query<Row \| null>` | |
| `findPage(args?)` | `PageQuery<Row>` | cursor pages in a stable order; `loadMore()` |
| `count({ where? })` | `Query<number>` | |
| `aggregate(args)` | `Query<…>` | **experimental**: count, sum, avg, min, max |
| `groupBy(args)` | `Query<…[]>` | **experimental**: the same per group, at most 1000 groups |
| `create({ data })` | `Write` | nested create of related rows |
| `update({ where: { id }, data })` | `Write` | |
| `upsert({ where: { id }, create, update })` | `Write` | |
| `delete({ where: { id } })` | `Write` | |
| `updateMany({ where, data })` | `Promise<{ count, queued? }>` | every matching row in one transaction, however many; commits whole or not at all. Applied to the cached rows it certainly matches and queued offline like any write; `queued: true` while it waits |
| `deleteMany({ where })` | `Promise<{ count }>` | as above |

A `Query` is awaitable, and live through `subscribe(listener)`, which receives
a `LiveState` (`{ data, isLoading, error }`) and returns an unsubscribe
function; `snapshot()` gives the current state. Reads go through the caller's
read rules. A `Write` is awaitable (it resolves to a `WriteResult`), is applied
optimistically and is queued while offline; a write the server refuses for
good reaches `onWriteRejected` with a `WriteRejection`.

On the client itself:

| Member | |
| --- | --- |
| `$transaction(writes)` | several writes, applied atomically → `Promise<WriteResult[]>` |
| `$files` | `FilesClient`: `upload(blob, { path })` → `StorageObject` (any size: past 16 MiB it goes up as a multipart upload of 16 MiB parts, abandoned if a part fails), `download(path)` → `Blob`, `delete(path)`, `list({ prefix? })` → `StoredFile[]` (the files the caller may read, each with `uploadedBy`) |
| `$presence(room)` | `PresenceRoom`: `set(presence)`, `cursor(cursor)`, `drag(drag)`, `clearDrag()`, `subscribe(listener)` with `PresencePeer[]`, `leave()` |
| `$broadcast(topic)` | **experimental**: `BroadcastTopic`: `send(message)` → `boolean | "queued"` (`"queued"` while the socket is down: sent after reconnecting, up to 100 per topic for 60 s; `false` when that queue is full), `subscribe((message, from) => …, { onError? })`, which never hears your own messages; never stored, never delivered late |
| `$across(workspaceIds, { getToken? })` | `Across`: per model `findMany`, `findFirst`, `findPage` and `count` over those workspaces, each with its own claim (`getToken(workspaceId)`, required unless the client uses the development claim route), merged in `orderBy` order; rows carry `workspaceId`; a page `cursor` holds a position per workspace. Results are `AcrossQuery` (awaitable, `subscribe`, `snapshot`, usable with `useLive`); live states add `errors` by workspace. A failed workspace rejects a one-off read with `AcrossError` (`errors`, `partial`) |
| `$export()` | `AsyncIterable<ExportRecord>`: every row and file entry the claim may read |
| `$history({ model, id })` | `Promise<HistoryEntry[]>`: each recorded change to the row, oldest first, as `{ seq, at, sub, role, action }` with `action` `"insert"`, `"update"` or `"delete"`; ADMIN or higher; needs `audit: true` on the Worker |
| `$flush()` | waits until queued writes are acknowledged |
| `$close()` | closes the socket |

Also exported: `id()` (time-ordered ids), `Query`, `PageQuery`, `Write`,
`WORKSPACE_ROLE_LEVELS`, `hasRole`, `hasRoleLevel`, and the
types `Client`, `ClientConfig`, `ModelClient`, `FindArgs`, `PageArgs`,
`Page`, `Result`, `LiveState`, `WriteResult`, `HistoryEntry`, `Across`, `AcrossModel`, `AcrossOptions`, `AcrossQuery`, `AcrossLiveState`, `AcrossError`, `QueryError`,
`WriteRejection`, `PresenceRoom`, `PresencePeer`, `RoleClaim`,
`WorkspaceRole`, `ExportRecord`, and **experimental** `BroadcastTopic` and
`TopicSender`.

## `@tapedb/tapedb/react` — hooks

| Hook | Returns |
| --- | --- |
| `useLive(query)` | `LiveState`: `{ data, isLoading, error }`; for an `AcrossQuery`, `AcrossLiveState` with `errors` too |
| `useLivePage(pageQuery)` | `LivePage`: `{ rows, hasMore, isLoading, error, loadMore }` |
| `usePresence(db, room, presence?)` | `PresencePeer[]`; publishes `presence` while mounted |
| `useBroadcast(db, topic, onMessage?)` | **experimental**: a `send(message) => boolean \| "queued"` function |

## `@tapedb/tapedb/worker`

**`defineTapeDB(options)`** → `{ worker, WorkspaceRoom }`. Export `worker` as
the default and `WorkspaceRoom` under that name (`tapedb init` writes this).

| Option | |
| --- | --- |
| `schema` | the schema |
| `migrations` | generated by `tapedb migrate dev` (`AppMigration[]`) |
| `identity` | `ClaimIdentity`: `getSubject(headers)` → `{ sub } \| null`, `getRole(workspaceId, sub)` → role or `null`, optional `limits` (`ClaimLimits`: `{ ip?, subject? }`, each `{ requests, perSeconds }` or `false`; defaults `{ requests: 300, perSeconds: 60 }` per IP before the session lookup and `{ requests: 30, perSeconds: 60 }` per subject after it; `false` turns both off), and optional `allowRequest(key)` → `boolean`, checked after the IP limit with `key` = `claim:<cf-connecting-ip>` (false → 429 `rate_limited`) |
| `devClaims` | serve the development claim route; refused in production |
| `retention` | `{ days }`: how long deleted or overwritten values may stay in history; default 30, at least 2 |
| `audit` | `true` records the writer (`sub`, role) of every write and keeps a per-row history for `$history`, within `retention`; default off |
| `topics` | **experimental**: `TopicOptions` `{ authorize?, replaySeconds? }`: a `TopicAuthorizer` for broadcast topics, and the seconds of each topic kept for listeners that reconnect (default 60, `0` keeps none) |

Also exported: `signRoleClaim(secret, { sub, workspaceId, role, iss?, aud?,
ttlSeconds? }, now?)` → `{ token, expiresAt, expiresIn }` and
`verifyRoleClaim(token, env, expectedWorkspaceId)` → `RoleClaim`, for minting
and checking claims outside the claim route (for example a backend that calls
export or erase), `ClaimError`,
`MAX_UPLOAD_BYTES` (25 MiB, the most one upload request carries; files of any size go up in parts), `WORKSPACE_ROLE_LEVELS`, and the types
`DefineTapeDBOptions`, `TapeDBWorker`, `AppMigration`, `ClaimIdentity`,
`Env`, `TapeDBSchema`, `BundledWorkspaceMigration`, and the type-only
`TapeDBRoom` name for the class returned by `defineTapeDB`. These named types
allow consumers to emit declarations without leaking private names.
`ModelOptions` is also exported from `@tapedb/tapedb/schema`.
`TopicAction` and `TopicAuthorizer` are **experimental**.

### Bindings and settings (`Env`)

| Name | Kind | |
| --- | --- | --- |
| `WORKSPACE` | Durable Object namespace | class `WorkspaceRoom` |
| `DATA` | R2 bucket | log segments and snapshots |
| `FILES` | R2 bucket, optional | uploads |
| `TAPEDB_CLAIM_SECRET` | secret | HS256 key for claims, at least 32 bytes |
| `TAPEDB_KEY_SECRET` | secret | stable wrapping and HMAC key for personal fields; required when the schema has personal fields |
| `TAPEDB_CLAIM_ISSUER`, `TAPEDB_CLAIM_AUDIENCE` | var, optional | checked when set |
| `ENVIRONMENT` | var | `production` refuses the development claim route |
| `TAPEDB_MOVE_FROM` | var, optional | source jurisdiction while moving: `none`, `eu` or `fedramp`; pair with `DATA_FROM` and `FILES_FROM`, and `WORKSPACE_FROM` for a different namespace |
| `TAPEDB_JURISDICTION` | var, optional | `eu` or `fedramp`; relocate existing workspaces with `tapedb move` |
| `TAPEDB_DEV_CLAIMS` | var or secret | development claim route on; never in production |
| `TAPEDB_DEV_CLAIMS_TOKEN` | secret, optional | the development claim route then needs `x-tapedb-dev-token` |

## `@tapedb/tapedb/seed`

A seeder is application code that fills a workspace with rows. The library ships
no fake data: names, postcodes, IBAN formats and every other domain convention
belong to the application. What this entry point owns is the bookkeeping around
the values.

```ts
// tapedb.seed.ts
import { defineSeeder } from "@tapedb/tapedb/seed";
import type app from "./tapedb.schema";

export default defineSeeder<typeof app>(async ({ ctx }) => {
  const customers = await ctx.create("customer", 12, (rng) => ({
    email: ctx.unique("customer", "email", (r) => `customer${r.int(1, 1e6)}@mail.test`),
    name: rng.pick(["Sanne", "Bram", "Noor"]),
    joinedAt: rng.past({ days: 400 }),
  }));

  await ctx.create("account", 16, (rng) => ({
    customerId: ctx.ref(customers),
    balanceMinor: rng.int(1_000, 90_000),
  }));
});
```

| member | |
| --- | --- |
| `create(model, count, build)` | builds rows and writes them; answers the ids |
| `insert(model, rows)` | writes rows you built yourself, for values that depend on other rows |
| `listIds(model)`, `ref(ids)` | parent ids, for foreign keys |
| `unique(model, field, generate)` | retries a generator until the value is unused in this run |
| `clear(model?)` | deletes rows, children before parents when no model is named |
| `model(name)` | fields, flags, uniqueness, personal and relations |
| `rng`, `rngFor(label)` | a seeded stream; `rngFor` depends only on its label |
| `written()` | rows this run wrote, per model |

Guarantees. The same `--seed` and the same seeder write the same rows. Rows are
written one transaction per 500 through the engine's own routes, so claims,
access rules, the tape and the history behave as they do for a client. A
`personal()` field is refused rather than written in the clear, because the
encryption key belongs to the application. Declared defaults are filled in, so a
row may leave them out.

`rng.past()` and `rng.future()` measure from now. Pass `from` to anchor them
(`rng.past({ days: 400, from: Date.UTC(2026, 10, 1) })`) when the same seed has to
give the same dates tomorrow as it does today. The three engine columns
(`createdAt`, `updatedAt`, `updatedSeq`) are written at insert, so they differ
between runs whatever the seed.

`npx tapedb-cli seed --workspace <uuid>` runs the seeder against a running
Worker, minting a development claim the way `export` does. `--dry-run` builds and
checks the rows without writing, `--if-empty` skips a workspace that already has
rows, `--model` restricts what a run may write, and `--seed <label>` chooses the
stream. A target that is not localhost is refused unless `--force` is passed.

## The studio

`tapedb studio` serves one HTML page: a table browser, the schema as an editable
outline, and a graph of the models. It needs no build step and makes no network
request at runtime.

**Structure** reads `tapedb.schema.ts` back as fields, shows an edit as a schema
diff plus the SQL it would run, and applies it through the same migration path as
`migrate dev`, so a change made in the browser is a change you would have
committed.

**Graph** draws the models with React Flow: one node per model listing its keys,
foreign keys, unique and personal fields with their types, and one edge per
`belongsTo`, labelled with the foreign-key field and `many → 1`, laid out so
parents sit left of the rows that point at them. Clicking a node opens that
model. The component is handed the engine's schema document, so it draws whatever
a workspace defines.

Every control is drawn by the studio rather than by the operating system: the
selects are listboxes with arrow, home and end navigation, `aria-expanded` and
`aria-selected`, and a hidden input so callers read `value` as before; the
checkboxes keep their input for semantics and `.checked`, with the brand's box
beside it.

React, React DOM, React Flow and esbuild are devDependencies of this package, and
the bundle is committed as `src/studio/graph.gen.ts`. That keeps two properties
that matter: `@tapedb/tapedb` has no runtime dependencies, and the page is a
single response whose script and style are covered by one hash each in the
`/_tapedb/studio` Content Security Policy. `node scripts/gen-studio-graph.mjs`
regenerates the bundle, and a test fails while it is out of date.

## HTTP

All engine routes need `Authorization: Bearer <claim>` for the workspace in
the path. Bodies and answers are JSON unless stated; errors are
`{ ok: false, error: { code, message } }`.

| Route | |
| --- | --- |
| `GET /status`, `GET /health` | the Worker's health; no claim |
| `POST /_tapedb/claim` | `{ workspaceId, role? }` → `{ token, workspaceId, roleLevel, expiresAt, expiresIn }` from the identity adapter. `role` asks for a claim at the caller's own role or below it (403 `role_above_membership` above it). The development route takes `{ workspaceId, role?, sub? }` (default OWNER and `dev-user`) and answers `{ token, workspaceId, roleLevel, expiresIn }` |
| `POST /engine/workspaces/:id/transact` | a transaction: `{ txId, clientTxId?, issuedAt?, ops }` |
| `POST /engine/workspaces/:id/query` | a one-off read |
| `GET /engine/workspaces/:id/schema` | the schema document the workspace runs: `namespaces` (fields with type, default and `personal`, and `access`: each action's rule, `role`, `filter` with the caller's evaluated `where`, or `check`), `links` (with each foreign key's `onDelete`), `files` (each file action's rule) and `caller` (`{ sub, role }`) |
| `GET /engine/workspaces/:id/status` | the workspace's status, including `durability: { seq, flushedSeq, snapshotSeq, lastFlushError }`: every write at or below `flushedSeq` is in R2. With `?after=<seq>`, it answers once a transaction lands past `seq`, or after 25 seconds |
| `GET /engine/workspaces/:id/export` | NDJSON export (below) |
| `GET /engine/workspaces/:id/history?model=…&id=…` | one row's recorded changes → `{ ok, data: HistoryEntry[] }`; ADMIN or higher; 409 `audit_disabled` without `audit: true` |
| `GET /engine/workspaces/:id/log?before=&limit=&model=` | the transaction log, newest first → `{ ok, data: { entries, next } }`; ADMIN or higher. Each entry: `seq`, `at`, the writer (`sub`, `role`; null without `audit: true`), `rows` and `counts` (rows per model and op) and up to 100 `ops`. Values are shown only for models whose read rule is a role the caller meets, never for personal fields; other ops list the fields in `hidden`. `limit` 1–100 (default 50); `next` is the `before` of the following page, null at the start of the retained log |
| `POST /engine/workspaces/:id/import` | owner-only atomic import of a consistent NDJSON export into an empty workspace; copies metadata, not file bytes |
| `POST /engine/workspaces/:id/move` | owner-only resumable move to `{ to: "eu" | "fedramp" | "none" }` matching the deployed configuration; preserves receipt ids and removes source data after switching traffic |
| `DELETE /engine/workspaces/:id` | erase the workspace; owner only; answers 410 afterwards |
| `GET`/`HEAD`/`PUT`/`DELETE /engine/workspaces/:id/files/:path` | file bytes; a `PUT` carries at most `MAX_UPLOAD_BYTES` |
| `POST /engine/workspaces/:id/files/:path?uploads` | start a multipart upload (the request's `content-type` is the file's) → `{ uploadId }`; EDITOR or higher, like every write below |
| `PUT …/files/:path?uploadId=…&partNumber=n` | store part n (1–10000, at most `MAX_UPLOAD_BYTES`; all but the last the same size, at least 5 MiB) → `{ partNumber, etag }` |
| `POST …/files/:path?uploadId=…` | `{ parts: [{ partNumber, etag }] }` completes it and records the file, like a `PUT` → 201 `{ key, size }` |
| `DELETE …/files/:path?uploadId=…` | abandon it (R2 also drops unfinished uploads after 7 days). Nothing is listed or readable before completion |
| `GET /engine/workspaces/:id/files` | the file index; MEMBER or higher, or with file rules any claim, filtered to readable files. The index changes only through the byte routes (other methods: 405) |
| `GET /engine/workspaces/:id/websocket` | the live socket (below) |

**Retries.** A transaction with `clientTxId` is applied at most once, without
an age limit. The receipt keeps its id, sequence and time permanently; its
operation hash is removed after half the history retention (15 days by
default). While the hash exists, different operations under the same id return
`conflict`; after its removal, the id acknowledges the original transaction
without applying the submitted operations. The client sends `issuedAt` for you.
An upgrade or restore from state with missing receipts preserves a fixed
boundary: unknown retries with `issuedAt` at or before it return
`retry_expired` (410). Known receipts are acknowledged even before that boundary.


**Export format, version 1.** One JSON object per line: a
`{"type":"header","format":"tapedb-export","version":1,…}` line, then `row`
and `file` lines, then `end` (with `consistent`) or `error`. A later format
changes `version`; readers check it.

## Live socket

`GET /engine/workspaces/:id/websocket` with the subprotocols `tapedb` and
`tapedb.claim.<claim>` (never a URL parameter). JSON messages:

- client → server: `query:subscribe`, `query:unsubscribe`, `presence:set`,
  `presence:clear`, `cursor:set`, `drag:set`, `drag:clear`, `ping`, and
  **experimental** `topic:join`, `topic:leave`, `topic:send`
- server → client: `session:ready`, `session:error`, `pong`, `query:data`,
  `query:diff`, `query:error`, `query:unsubscribed`, `presence:update`,
  `cursor:update`, `drag:update`, `error`, and **experimental** `topic:message`, `topic:error`

Messages have no size bound of TapeDB's own. A frame is at most
Cloudflare's 32 MiB; the client sends a message longer than 256 Ki
characters as frames of that size:

- `{ type: "part", id, index, last, data }`: slices of the message's JSON,
  which the workspace stores until the last and then runs as one message.
  Parts out of order answer `error` `part_out_of_order` and drop the message.
- for `topic:send`, `{ type: "topic:send", topic, part: { id, index, last },
  data }`: slices of the topic message's JSON, relayed to listeners as
  `topic:message` with the same `part` and `data` and joined by the
  receiving client. The workspace never holds the whole message.

Topics (**experimental**): every `topic:message` carries the topic's `seq`,
and `origin` when the sender gave one (`topic:send { origin }`, a stable id
of the sending client, so it can skip its own messages when they are
replayed). `topic:join { topic, since? }` answers `topic:joined { topic, seq }`
after replaying the kept messages with a sequence above `since` (the last
`topics.replaySeconds`, default 60, at most 1,000 per topic; engine
migration `tapedb_0009_topic_buffer`).

A socket's live queries, presence and topics are kept in its attachment
while they fit (12 KiB) and in the workspace's storage past that (engine
migration `tapedb_0007_socket_state`), so a socket may hold any number of
them. The protocol belongs to the client; use it directly only if you must.

## CLI

`npx tapedb-cli init | migrate dev|rollback|status|check|squash | dev | studio |
deploy | export | seed | erase | move`. The exact commands and flags are in `npx tapedb-cli --help`
and are part of the checked surface. `deploy` refuses when `ENVIRONMENT` is not
`production`, when `TAPEDB_DEV_CLAIMS` is set, when an R2 bucket is outside
`TAPEDB_JURISDICTION`, or when `migrate check` fails (no migrations, schema
changes without a migration, or a stale generated migrations file).

### Squashing a run

`migrate squash --since <id>` folds that migration and everything after it into
the first one. The SQL is re-derived from the snapshots at each end of the run,
so the result is the net change rather than a concatenation, and a run that adds
a column and later drops it is removed entirely because it applies nothing.

The first migration of the run keeps its id, which is why a development database
that already applied the run needs no repair: the id it recorded still exists and
now carries the whole change. `--dry-run` reports without writing, and
`--accept-data-loss` is required when the net change drops something.

A run containing a statement that touched rows (an `UPDATE`, a backfill) is
refused, because a re-derived DDL diff cannot carry it.

## Error codes

Every code the engine and Worker answer with is listed in
[api/surface.json](api/surface.json) (`errorCodes`) and is stable: a code is
never repurposed. New codes may be added in a minor release. The ones an app
usually handles:

| Code | Status | Meaning |
| --- | --- | --- |
| `permission_denied` | 403 | a write or read rule refused |
| `insufficient_role` | 403 | the claim's role is too low |
| `not_a_member` | 403 | the claim route found no role for the caller in that workspace |
| `role_above_membership` | 403 | the claim route was asked for a role above the caller's own |
| `rate_limited` | 429 | a claim limit or `identity.allowRequest` refused a claim request; built-in limits send `Retry-After` |
| `unique_violation`, `foreign_key_violation` | 409 | a constraint refused the write |
| `conflict` | 409 | a `clientTxId` reused with different operations |
| `retry_expired` | 410 | an unknown retry before the fixed receipt boundary of a legacy upgrade or restore; send it as a new write if it still applies |
| `workspace_moving` | 409 | writes are frozen during a move; keep them queued and retry |
| `workspace_moved` | 308 | the old workspace moved; use the move-aware destination Worker |
| `workspace_importing` | 409 | an import is in progress |
| `audit_disabled` | 409 | `$history` on a Worker without `audit: true` |
| `workspace_erased` | 410 | the workspace was erased |
| `workspace_recovering` | 503 | the workspace is being restored from R2; retry after `Retry-After` seconds. The client retries on its own for up to a minute |
| `invalid_claim`, `claim_expired`, `invalid_signature`, `missing_token`, `wrong_workspace` | 401/403 | the claim |
| `jurisdiction_mismatch` | 500 | the Worker reached a room outside `TAPEDB_JURISDICTION` |

## Personal data

### Enums

`t.enum([...])` is a string with a closed set. Values must be non-empty and
unique, `.default()` takes one of them, `.index()` and `.unique()` work as they
do on a string, and `.personal()` throws: the set is public and the check needs
plaintext.

The column is TEXT and the migration snapshot records only the type, so changing
the list needs no migration. The engine refuses a write outside the set with
`invalid_value`, whatever the client believed, and the values reach
`ctx.model(name).fields[field].values` for a seeder.

`t.string().personal({ subject: "self" | "<string field>" })` and
`t.json().personal(...)` encrypt values under a subject key. Personal output
fields are nullable and erased fields appear in the row's `$erased: string[]`.
Personal fields support selection and access rules; filters, ordering,
aggregates, indexes and uniqueness are refused.

`db.$erasePerson(subject): Promise<void>` uses
`DELETE /engine/workspaces/:id/subjects/:subject` with an owner claim. URL-encode
the subject. Success is `{ ok: true }`; repeated erasure succeeds. The key is
removed from R2, making existing ciphertext unreadable. Later writes create a
new independent key. Ordinary fields and files are unchanged.

Workers with personal fields require `TAPEDB_KEY_SECRET`, a stable random secret
of at least 32 characters. Moves require the same secret at both destinations.
Existing plaintext rows are encrypted in resumable batches before reads resume.
Historical plaintext copies retain their original retention windows.

Broadcast `send` returns `false` for JSON messages exceeding 4 MiB, before
queueing or sending them. Multipart transmission obeys the same message bound.

### Interactive setup

`npx tapedb-cli init` asks for a project name and local or cloud setup, installs the library and Wrangler using the project package manager, and offers to start the local database. `--local`, `--cloud`, `--name`, `--yes`, `--no-install` and `--no-start` support scripted setup. `--yes` uses defaults and does not select cloud deployment unless `--cloud` is also supplied.

`tapedb deploy` selects the Cloudflare account, shows the deployment target, creates missing R2 buckets and missing secrets, then deploys the Worker. Existing remote secrets are preserved. `--yes` accepts the displayed deployment plan for CI. Unmigrated schemas, dev-claim variables and inconsistent data jurisdictions still refuse deployment.


## Built-in authentication

Install Better Auth only in applications that use auth. `@tapedb/tapedb/auth` exports:

- `tapedbAuth({ database, debugLogs? })`: Better Auth `createAdapterFactory` adapter.
- `authDatabase(env)`: the app-wide `AuthRoom` stub named `auth`, respecting `TAPEDB_JURISDICTION`.
- `eraseAuthUser(env, userId)`: the `user.deleteUser.beforeDelete` hook generated by init. It refuses sole owners, erases the user's personal data in their workspaces, and removes membership. Erasure jobs survive retries.
- `TapeDBAuthEnv`: Worker bindings including optional AUTH, EMAIL, BETTER_AUTH_SECRET and EMAIL_FROM.

`defineTapeDB({ schema, auth, studio })` accepts a Better Auth server or `(env, request) => server`. Export `tapedb.AuthRoom`, bind it as AUTH, and declare it in a new SQLite Durable Object migration. `auth` and a custom `identity` are mutually exclusive. Authenticated deployments do not accept the development claim bypass. Better Auth keeps its own client API and `/api/auth/*` routes.

| Route | Behaviour |
| --- | --- |
| `/api/auth/*` | Better Auth handler, including sign-in, verification, reset and sessions |
| `GET /_tapedb/workspaces` | Only the signed-in user's memberships |
| `POST /_tapedb/workspaces` | Creates a UUID workspace and assigns its creator OWNER |
| `GET /_tapedb/auth/members?workspaceId=<uuid>` | Member profiles and roles; ADMIN or OWNER |
| `POST /_tapedb/auth/members?workspaceId=<uuid>` | OWNER only; `{ userId, role }`, levels 0–6, or null to remove |
| `GET /_tapedb/studio/users` | Sign-in, workspaces, membership, own sessions and erasure UI |
| `GET /_tapedb/dev/emails` | Local inbox only on loopback, outside production, with TAPEDB_DEV_CLAIMS=true |

Membership never appears as a side effect of claiming an arbitrary workspace. The final owner cannot be demoted, removed or erased before ownership is transferred. Existing claims expire within five minutes; revoking a Better Auth session prevents new claims.

`t.belongsTo("$users")` adds a managed `tapedb_users` table with id, name and image. Claim issuance projects the workspace's member profiles through ordinary taped transactions. Apps cannot write these profiles. Includes and relation filters by user id work normally. Names and images use personal-field encryption and are not filterable. A schema referencing `$users` requires built-in auth.

AuthRoom uses Durable Object SQLite persistence. Each adapter operation is atomic; asynchronous transactions spanning multiple Better Auth operations are not advertised as supported. Optional plugin columns can be added; renaming/removing fields or adding required columns needs an explicit migration. Do not rename an auth model or field on an existing database without migrating its stored data.

## Email

`@tapedb/tapedb/email` exports `mailer({ from, binding, development? })`. Its `send({ to, subject, text?, html? })` returns `{ messageId }` through Cloudflare's structured `send_email` binding. Missing production bindings fail. Development capture prints messages and keeps the last 100 for up to an hour in the current isolate, without sending. Generated auth enables capture only during `tapedb dev`, never in production.

Cloudflare Email Service sending is beta and requires Workers Paid and an onboarded sender domain. Auth init adds EMAIL, installs Better Auth, and generates BETTER_AUTH_SECRET locally; deploy generates a missing remote secret and onboards EMAIL_FROM's domain without rotating existing secrets. OAuth providers remain configured through Better Auth's normal options.


## Custom auth page

The project-root convention is **`tapedb.auth.tsx`**, with a default-exported React component. It runs in the browser and may import CSS or CSS modules. The generated entry supplies `AuthPageProps` from `@tapedb/tapedb/react`: `{ redirectTo: string }`. The redirect is restricted to the same origin and defaults to `/_tapedb/studio`.

```tsx
// tapedb.auth.tsx — browser code
import { useState } from "react";
import { createAuthClient } from "better-auth/client";
import type { AuthPageProps } from "@tapedb/tapedb/react";
import "./auth.css";

const client = createAuthClient();
export default function AuthPage({ redirectTo }: AuthPageProps) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  return <form onSubmit={async event => {
    event.preventDefault();
    const { error } = await client.signIn.email({
      email, password: String(new FormData(event.currentTarget).get("password")),
      callbackURL: redirectTo,
    });
    if (error) setMessage(error.message ?? "Sign-in failed");
    else location.assign(redirectTo);
  }}>
    <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label>
    <label>Password<input name="password" type="password" required /></label>
    <button type="submit">Sign in</button>
    <p role="status">{message}</p>
  </form>;
}
```

`npx tapedb-cli dev` discovers the file and watches its component/CSS imports. Removing it restores the built-in page. `npx tapedb-cli deploy` builds it before provisioning. A broken component fails the build. `npx tapedb-cli auth build` generates the artifact independently for a typecheck or custom Wrangler pipeline; run it before using raw Wrangler commands. The project needs React/React DOM 19 and esbuild. Init installs esbuild with auth and adds React dependencies when the convention is already present; existing React projects retain their dependencies.

New `init --auth` Workers import the generated `authPage` from `./tapedb/auth-page.gen` and pass it to `defineTapeDB({ auth, authPage, studio, ... })`. Existing Workers add that import and option once, then run `tapedb auth build`. The generated file is ignored by version control; regenerate it before checking the app's Worker types on a fresh checkout. No React code runs in the Worker or is added to applications using the built-in page.

`TapeDBAuthPage` from `@tapedb/tapedb/worker` is `{ javascript: string; css?: string; title?: string }`. An app with its own build pipeline may pass that object directly. `GET /auth` serves the override; `/_tapedb/auth/page.js` and `.css` serve its browser assets. Studio redirects unsigned users to `/auth?returnTo=<local path>`. Custom assets have their own policy: same-origin scripts and API requests, local CSS/inline style properties, and HTTPS/data images and fonts. Auth API routes and membership enforcement are unchanged by the page.

Keep server-only `auth.ts` separate. The React page uses Better Auth's own browser client; it must not import the server auth instance or bindings.
