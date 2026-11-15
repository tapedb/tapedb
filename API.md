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
| `tapedb` | browser, Node, Workers | the client, schema builders, ids, roles |
| `tapedb/schema` | anywhere | only what a schema file needs |
| `tapedb/react` | browser (React 19 peer) | hooks |
| `tapedb/worker` | Cloudflare Workers | `defineTapeDB` and claim helpers |
| `npx tapedb` | Node 22.18+ | the CLI (a command, not an import) |

`tapedb` has no runtime dependencies and never imports React.

## `tapedb/schema` — stable

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

## `tapedb` — client

Everything in `tapedb/schema`, plus:

**`createClient({ schema, url, workspace, getToken?, onWriteRejected? })`** →
`Client`. Without `getToken` the client asks the development claim route for a
token, which only `tapedb dev` (or a gated test Worker) serves.

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
| `$export()` | `AsyncIterable<ExportRecord>`: every row and file entry the claim may read |
| `$flush()` | waits until queued writes are acknowledged |
| `$close()` | closes the socket |

Also exported: `id()` (time-ordered ids), `Query`, `PageQuery`, `Write`,
`WORKSPACE_ROLE_LEVELS`, `hasRole`, `hasRoleLevel`, and the
types `Client`, `ClientConfig`, `ModelClient`, `FindArgs`, `PageArgs`,
`Page`, `Result`, `LiveState`, `WriteResult`, `QueryError`,
`WriteRejection`, `PresenceRoom`, `PresencePeer`, `RoleClaim`,
`WorkspaceRole`, `ExportRecord`, and **experimental** `BroadcastTopic` and
`TopicSender`.

## `tapedb/react` — hooks

| Hook | Returns |
| --- | --- |
| `useLive(query)` | `LiveState`: `{ data, isLoading, error }` |
| `useLivePage(pageQuery)` | `LivePage`: `{ rows, hasMore, isLoading, error, loadMore }` |
| `usePresence(db, room, presence?)` | `PresencePeer[]`; publishes `presence` while mounted |
| `useBroadcast(db, topic, onMessage?)` | **experimental**: a `send(message) => boolean \| "queued"` function |

## `tapedb/worker`

**`defineTapeDB(options)`** → `{ worker, WorkspaceRoom }`. Export `worker` as
the default and `WorkspaceRoom` under that name (`tapedb init` writes this).

| Option | |
| --- | --- |
| `schema` | the schema |
| `migrations` | generated by `tapedb migrate dev` (`AppMigration[]`) |
| `identity` | `ClaimIdentity`: `getSubject(headers)` → `{ sub } \| null`, `getRole(workspaceId, sub)` → role or `null`, optional `limits` (`ClaimLimits`: `{ ip?, subject? }`, each `{ requests, perSeconds }` or `false`; defaults `{ requests: 300, perSeconds: 60 }` per IP before the session lookup and `{ requests: 30, perSeconds: 60 }` per subject after it; `false` turns both off), and optional `allowRequest(key)` → `boolean`, checked after the IP limit with `key` = `claim:<cf-connecting-ip>` (false → 429 `rate_limited`) |
| `devClaims` | serve the development claim route; refused in production |
| `retention` | `{ days }`: how long deleted or overwritten values may stay in history; default 30, at least 2 |
| `topics` | **experimental**: `TopicOptions` `{ authorize?, replaySeconds? }`: a `TopicAuthorizer` for broadcast topics, and the seconds of each topic kept for listeners that reconnect (default 60, `0` keeps none) |

Also exported: `signRoleClaim(secret, { sub, workspaceId, role, iss?, aud?,
ttlSeconds? }, now?)` → `{ token, expiresAt, expiresIn }` and
`verifyRoleClaim(token, env, expectedWorkspaceId)` → `RoleClaim`, for minting
and checking claims outside the claim route (for example a backend that calls
export or erase), `ClaimError`,
`MAX_UPLOAD_BYTES` (25 MiB, the most one upload request carries; files of any size go up in parts), `WORKSPACE_ROLE_LEVELS`, and the types
`DefineTapeDBOptions`, `TapeDBWorker`, `AppMigration`, `ClaimIdentity`,
`Env`, and **experimental** `TopicAction` and `TopicAuthorizer`.

### Bindings and settings (`Env`)

| Name | Kind | |
| --- | --- | --- |
| `WORKSPACE` | Durable Object namespace | class `WorkspaceRoom` |
| `DATA` | R2 bucket | log segments and snapshots |
| `FILES` | R2 bucket, optional | uploads |
| `TAPEDB_CLAIM_SECRET` | secret | HS256 key for claims |
| `TAPEDB_CLAIM_ISSUER`, `TAPEDB_CLAIM_AUDIENCE` | var, optional | checked when set |
| `ENVIRONMENT` | var | `production` refuses the development claim route |
| `TAPEDB_MOVE_FROM` | var, optional | source jurisdiction while moving: `none`, `eu` or `fedramp`; pair with `DATA_FROM` and `FILES_FROM`, and `WORKSPACE_FROM` for a different namespace |
| `TAPEDB_JURISDICTION` | var, optional | `eu` or `fedramp`; relocate existing workspaces with `tapedb move` |
| `TAPEDB_DEV_CLAIMS` | var or secret | development claim route on; never in production |
| `TAPEDB_DEV_CLAIMS_TOKEN` | secret, optional | the development claim route then needs `x-tapedb-dev-token` |

## HTTP

All engine routes need `Authorization: Bearer <claim>` for the workspace in
the path. Bodies and answers are JSON unless stated; errors are
`{ ok: false, error: { code, message } }`.

| Route | |
| --- | --- |
| `GET /status`, `GET /health` | the Worker's health; no claim |
| `POST /_tapedb/claim` | `{ workspaceId }` → `{ token, workspaceId, roleLevel, expiresAt, expiresIn }` from the identity adapter; the development route answers `{ token, workspaceId, expiresIn }` |
| `POST /engine/workspaces/:id/transact` | a transaction: `{ txId, clientTxId?, issuedAt?, ops }` |
| `POST /engine/workspaces/:id/query` | a one-off read |
| `GET /engine/workspaces/:id/schema` | the schema document the workspace runs |
| `GET /engine/workspaces/:id/status` | the workspace's status, including `durability: { seq, flushedSeq, snapshotSeq, lastFlushError }`: every write at or below `flushedSeq` is in R2 |
| `GET /engine/workspaces/:id/export` | NDJSON export (below) |
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

`npx tapedb init | migrate dev|status|check | dev | studio | deploy | export
| erase | move`. The exact commands and flags are in `npx tapedb --help` and are
part of the checked surface. `deploy` refuses when `ENVIRONMENT` is not
`production`, when `TAPEDB_DEV_CLAIMS` is set, when an R2 bucket is outside
`TAPEDB_JURISDICTION`, or when `migrate check` fails (no migrations, schema
changes without a migration, or a stale generated migrations file).

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
| `rate_limited` | 429 | a claim limit or `identity.allowRequest` refused a claim request; built-in limits send `Retry-After` |
| `unique_violation`, `foreign_key_violation` | 409 | a constraint refused the write |
| `conflict` | 409 | a `clientTxId` reused with different operations |
| `retry_expired` | 410 | an unknown retry before the fixed receipt boundary of a legacy upgrade or restore; send it as a new write if it still applies |
| `workspace_moving` | 409 | writes are frozen during a move; keep them queued and retry |
| `workspace_moved` | 308 | the old workspace moved; use the move-aware destination Worker |
| `workspace_importing` | 409 | an import is in progress |
| `workspace_erased` | 410 | the workspace was erased |
| `workspace_recovering` | 503 | the workspace is being restored from R2; retry after `Retry-After` seconds |
| `invalid_claim`, `claim_expired`, `invalid_signature`, `missing_token`, `wrong_workspace` | 401/403 | the claim |
| `jurisdiction_mismatch` | 500 | the Worker reached a room outside `TAPEDB_JURISDICTION` |

## Personal data

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
