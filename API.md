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

`schema`, `model`, `t` (field builders), `role`, `filter`, `check`, and the
types `Schema`, `Row`, `Where`, `FieldFilter`, `OrderBy`, `Include`,
`CreateData`, `UpdateData`, `DeleteBehaviour`, `ScalarKind`, `Access`,
`AccessAuth`, `CheckContext`.

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
| `updateMany({ where, data })` | `Promise<{ count }>` | up to 1000 rows in one transaction, then batches of 1000 in id order; a failed batch rejects with `BulkWriteError { written, cause }` |
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
| `$files` | `FilesClient`: `upload(blob, { path })` → `StorageObject`, `download(path)` → `Blob`, `delete(path)`, `list({ prefix? })` → `StoredFile[]` |
| `$presence(room)` | `PresenceRoom`: `set(presence)`, `cursor(cursor)`, `drag(drag)`, `clearDrag()`, `subscribe(listener)` with `PresencePeer[]`, `leave()` |
| `$broadcast(topic)` | **experimental**: `BroadcastTopic`: `send(message)` → `boolean` (false, and dropped, when the socket is not open), `subscribe((message, from) => …, { onError? })`, which never hears your own messages; never stored, never delivered late |
| `$export()` | `AsyncIterable<ExportRecord>`: every row and file entry the claim may read |
| `$flush()` | waits until queued writes are acknowledged |
| `$close()` | closes the socket |

Also exported: `id()` (time-ordered ids), `Query`, `PageQuery`, `Write`,
`BulkWriteError`, `WORKSPACE_ROLE_LEVELS`, `hasRole`, `hasRoleLevel`, and the
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
| `useBroadcast(db, topic, onMessage?)` | **experimental**: a `send(message) => boolean` function |

## `tapedb/worker`

**`defineTapeDB(options)`** → `{ worker, WorkspaceRoom }`. Export `worker` as
the default and `WorkspaceRoom` under that name (`tapedb init` writes this).

| Option | |
| --- | --- |
| `schema` | the schema |
| `migrations` | generated by `tapedb migrate dev` (`AppMigration[]`) |
| `identity` | `ClaimIdentity`: `getSubject(headers)` → `{ sub } \| null`, `getRole(workspaceId, sub)` → role or `null`, and optional `allowRequest(key)` → `boolean`, checked first with `key` = `claim:<cf-connecting-ip>` (false → 429 `rate_limited`), for the public claim route |
| `devClaims` | serve the development claim route; refused in production |
| `retention` | `{ days }`: how long deleted or overwritten values may stay in history; default 30, at least 2 |
| `topics` | **experimental**: `{ authorize }`, a `TopicAuthorizer` for broadcast topics |

Also exported: `signRoleClaim(secret, { sub, workspaceId, role, iss?, aud?,
ttlSeconds? }, now?)` → `{ token, expiresAt, expiresIn }` and
`verifyRoleClaim(token, env, expectedWorkspaceId)` → `RoleClaim`, for minting
and checking claims outside the claim route (for example a backend that calls
export or erase), `ClaimError`,
`MAX_UPLOAD_BYTES` (25 MiB), `WORKSPACE_ROLE_LEVELS`, and the types
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
| `TAPEDB_JURISDICTION` | var, optional | `eu` or `fedramp`; set before the first deploy |
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
| `GET /engine/workspaces/:id/status` | the workspace's status |
| `GET /engine/workspaces/:id/export` | NDJSON export (below) |
| `DELETE /engine/workspaces/:id` | erase the workspace; owner only; answers 410 afterwards |
| `GET`/`HEAD`/`PUT`/`DELETE /engine/workspaces/:id/files/:path` | file bytes |
| `GET /engine/workspaces/:id/files` | the file index; MEMBER or higher. The index changes only through the byte routes (other methods: 405) |
| `GET /engine/workspaces/:id/websocket` | the live socket (below) |

**Retries.** A transaction with `clientTxId` is applied at most once: a retry
with the same id is answered from its receipt. Receipts are kept for half the
history retention (15 days by default). A retry with `issuedAt` before that,
whose receipt may be gone, is refused with `retry_expired` (410). The client
sends `issuedAt` for you.

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

Frames above 64 KiB are refused. The protocol belongs to the client; use it
directly only if you must.

## CLI

`npx tapedb init | migrate dev|status|check | dev | studio | deploy | export
| erase`. The exact commands and flags are in `npx tapedb --help` and are
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
| `rate_limited` | 429 | `identity.allowRequest` refused a claim request |
| `unique_violation`, `foreign_key_violation` | 409 | a constraint refused the write |
| `conflict` | 409 | a `clientTxId` reused with different operations |
| `retry_expired` | 410 | a retry too old to deduplicate safely; send it again as a new write if it still applies |
| `workspace_erased` | 410 | the workspace was erased |
| `invalid_claim`, `claim_expired`, `invalid_signature`, `missing_token`, `wrong_workspace` | 401/403 | the claim |
| `jurisdiction_mismatch` | 500 | the Worker reached a room outside `TAPEDB_JURISDICTION` |
