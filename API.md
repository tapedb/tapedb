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
| `@tapedb/tapedb/react` | browser (React 18 or 19 peer) | hooks |
| `@tapedb/tapedb/worker` | Cloudflare Workers | `defineTapeDB` and claim helpers |
| `@tapedb/tapedb/studio` | Cloudflare Workers | `studio`: the studio at `/_tapedb/studio`, for `defineTapeDB({ studio })` |
| `@tapedb/tapedb/seed` | Node (the CLI) | `defineSeeder`, `runSeeder` and the seeding context |
| `npx tapedb-cli` | Node 22.18+ | the CLI, a separate package that runs the matching `@tapedb/tapedb` |

`@tapedb/tapedb` has no runtime dependencies and never imports React.

## `@tapedb/tapedb/schema` — stable

`schema`, `model`, `t` (field builders), `role`, `filter`, `check`,
`fileCheck`, `attachedTo`, `encodeVector`, `decodeVector`, `VECTOR_TAG`,
`VECTOR_MAX_DIMENSIONS`, and the types `Schema`, `Row`, `Where`,
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

### Vectors

`t.vector({ dimensions })` is an embedding: a fixed-length list of numbers.
`dimensions` is an integer from 1 to 1,536, checked when the schema is defined,
so `0`, a negative count, `1,537`, `1.5` and a missing count all fail there.
`.optional()` works as it does on every other kind. `.default()`, `.index()`,
`.unique()` and `.personal()` are refused: an embedding is per row, and it is
not filterable, sortable, groupable or aggregatable.

```ts
note: model({
  title: t.string(),
  embedding: t.vector({ dimensions: 768 }).optional(),
})
```

A write passes the numbers, `embedding: [0.1, -0.2, ...]`. The engine checks
the length against the declaration, requires every element to be a finite
number that stays finite as float32 (so `1e39`, which overflows, is refused),
stores `-0` as `+0`, and refuses an all-zero vector. That last check runs
**after** the conversion to float32, so a vector of values too small for
float32 (`1e-50`) is refused rather than stored as zeros. `null` clears the
field; leaving it out of an update keeps it. A refused vector fails the whole
transaction before commit: no row, no receipt and no log entry are written, and
any other op in that transaction rolls back with it.

**Storage is one opaque string**: `f32le:v1:<base64>` — the tag, then the
values as little-endian float32, four bytes each, base64. At 768 dimensions the
payload is 3,072 bytes and the base64 body 4,096 characters; at 1,536 it is
6,144 bytes and 8,192 characters, plus the 9-character tag. The string is the
value: SQLite holds it in a `TEXT` column, and the transaction log, snapshots,
`$export` and backup `rows.ndjson` all carry it verbatim, so a row is
byte-identical through each of them. It is also smaller than a JSON array of
the same numbers: against the real log writer, 768-dimension values fit 60 rows
in a 256 KiB log part where the JSON form fits 15, and a 100-write replay
payload is 432,804 B instead of 1,676,201 B (−74%; −57% gzipped).

`f32le:v1:` is the version. A later codec is a new tag, not a migration, and a
value with a tag this build does not know is refused rather than guessed at.
A read returns the stored string; `decodeVector(text, dimensions?)` gives the
numbers back and `encodeVector(values, dimensions)` produces the string a write
accepts (`number[]` is accepted too).

An embedding is never part of a default projection: a plain read leaves the
attribute out of the row entirely. Name it to get it —
`select: { id: true, embedding: true }` — and that is the only thing that
returns it. The client refuses to filter, order or group by a vector field, and
the engine refuses a filter, a `groupBy` and every aggregate measure on one
(`invalid_value`).

Nothing here talks to Cloudflare Vectorize: this is the field, its encoding and
its validation. Mirroring it into an index is `defineTapeDB({ vectorize })`, in
[`@tapedb/tapedb/worker`](#vector-search); querying that index is
`db.<model>.search({ vector })` on the client.

## `@tapedb/tapedb` — client

Everything in `@tapedb/tapedb/schema`, plus:

**`createClient({ schema, url, workspace, userId?, getToken?, onWriteRejected?, outbox? })`** →
`Client`. Without `getToken` the client asks the development claim route for a
token, which only `tapedb dev` (or a gated test Worker) serves. Browser clients
using the default IndexedDB outbox must supply `userId` matching the claim subject
(`dev-user` in development). Close and recreate clients on account changes;
legacy unscoped queues are retained but never automatically replayed.

`outbox` replaces that default: pass an `Outbox` — or a factory, which is called once and shared with
the `$across` clients this client creates — when the runtime has no IndexedDB. An injected outbox also
replaces the `userId` requirement, because the caller has already decided where the queue lives and how
it is scoped. See [Offline queue](#offline-queue).

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
| `search({ text?\|vector?, limit?, filter?, where?, select? })` | `Promise<{ rows, truncated, mode, reranked }>` | nearest neighbour over the vector field this deployment indexes, with keyword recall and an optional reranker; `text` is embedded by the deployment's own model, `vector` is a query the caller embedded; rows come back nearest first, each carrying `score`; see [Vector search](#vector-search) |
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
| `$presence(room)` | `PresenceRoom`: `set(presence)`, `cursor(cursor)`, `drag(drag)`, `clearDrag()`, `peers({ includeSelf? })` → `PresencePeer[]`, `subscribe(listener, { includeSelf?, onError? })` with `PresencePeer[]`, `leave()`. A socket holds several rooms at once (below) |
| `$broadcast(topic)` | **experimental**: `BroadcastTopic`: `send(message)` → `boolean | "queued"` (`"queued"` while the socket is down: sent after reconnecting, up to 100 per topic for 60 s; `false` when that queue is full), `subscribe(listener, { onError?, onGap? })`, `lastSeq`, `gap`; never hears your own messages; never stored, never delivered late |
A reconnecting listener is sent what it missed, each message once and in
order. When the replay window no longer holds what it missed, `onGap` reports
`{ topic, expected, received }` — the first missing sequence and the one that
arrived — and `gap` keeps that last jump until the topic is left, so a caller can
resynchronise instead of mistaking loss for quiet. `lastSeq` is the highest
sequence seen. Your own messages never count as a gap, and a reconnect that
resumes exactly leaves `gap` null.

| `$across(workspaceIds, { getToken? })` | `Across`: per model `findMany`, `findFirst`, `findPage` and `count` over those workspaces, each with its own claim (`getToken(workspaceId)`, required unless the client uses the development claim route), merged in `orderBy` order; rows carry `workspaceId`; a page `cursor` holds a position per workspace. Results are `AcrossQuery` (awaitable, `subscribe`, `snapshot`, usable with `useLive`); live states add `errors` by workspace. A failed workspace rejects a one-off read with `AcrossError` (`errors`, `partial`) |
| `$export()` | `AsyncIterable<ExportRecord>`: every row and file entry the claim may read |
| `$history({ model, id })` | `Promise<HistoryEntry[]>`: each recorded change to the row, oldest first, as `{ seq, at, sub, role, action }` with `action` `"insert"`, `"update"` or `"delete"`; ADMIN or higher; needs `audit: true` on the Worker |
| `$flush()` | makes one delivery attempt for the queued writes and resolves when that attempt finishes. It does **not** wait for acknowledgement: an unreachable server leaves the entry queued and a retry is scheduled, so read it as "try now", not "is synced". a caller that must know a write landed has to track that itself |
| `clientId` | this socket's session id, assigned by the server on `session:ready` and the id a `PresencePeer` carries. `undefined` until the socket opens, and against a Worker that predates multiple presence rooms |
| `$close()` | closes the socket |

Also exported: `id()` (time-ordered ids), `Query`, `PageQuery`, `Write`,
`WORKSPACE_ROLE_LEVELS`, `hasRole`, `hasRoleLevel`, and the
types `Client`, `ClientConfig`, `ModelClient`, `FindArgs`, `PageArgs`,
`Page`, `Result`, `LiveState`, `WriteResult`, `HistoryEntry`, `Across`, `AcrossModel`, `AcrossOptions`, `AcrossQuery`, `AcrossLiveState`, `AcrossError`, `QueryError`,
`WriteRejection`, `PresenceRoom`, `PresencePeer`, `RoleClaim`,
`WorkspaceRole`, `ExportRecord`, `SearchArgs`, `SearchFilter` and `SearchResult`, and **experimental** `BroadcastTopic` and `TopicSender`.

### Offline queue

Writes go out optimistically and wait in an `Outbox` until the server acknowledges them; after a
restart the queue is read back and replayed, and each entry keeps its `clientTxId`, so a replay applies
at most once.

| | |
| --- | --- |
| `Outbox` | `add(entry)`, `list(workspaceId)`, `remove(clientTxId)`, `clear(workspaceId?)` — implement these four and a runtime has a durable queue |
| `OutboxEntry` | `{ clientTxId, txId, workspaceId, ops, createdAt, attempts }`; ordering is by `createdAt`, not by storage order |
| `MemoryOutbox` | in-memory, for tests and server rendering. Anything still queued is **lost when the process exits**, so it is not a durable queue |
| `IndexedDbOutbox` | the browser default, scoped to `userId` |
| `AsyncStorageOutbox` | any async key-value store: `getItem`, `setItem`, `removeItem`, `getAllKeys`, and a batch delete (`multiRemove` on v1/v2, `removeMany` on v3, or neither — it then removes one key at a time). Keys are `prefix + clientTxId`, so two accounts on one device stay apart. Pass `prefix: scopedOutboxName(url, userId) + ":"` to scope it the way the browser does |

`@tapedb/react-native` is the packaged form of this: `createReactNativeClient({ schema, url, workspace, userId })`
wires an `AsyncStorageOutbox` for you and re-exports the React hooks. A store that fails a write does
not lose it — the entry stays in the outbox it was written to and a later flush still sees it. That is
durable only if the outbox is: with the default `MemoryOutbox` the entry survives the failed write but
not the process, which is why a browser or device client needs `IndexedDbOutbox` or `AsyncStorageOutbox`.

### Filters

A `where` entry is a field and either a value or a comparison object. Building a
query checks the filter against the schema, so an unknown field or operator
throws at the call, and the engine refuses the same filters with `invalid_value`.

| Filter | Matches |
| --- | --- |
| a value, or `null` | the rows whose field is that value; `null` is `IS NULL` |
| `{ not: value }`, `$ne` | the rows whose field is another value, and those where it is null |
| `$in`, `$nin` | any or none of a list; a `null` in a `$in` list also matches rows where the field is null, and `$nin` matches those rows unless `null` is listed |
| `$gt`, `$gte`, `$lt`, `$lte` | a comparison on a number, a date (epoch milliseconds) or a string |
| `$isNull: boolean` | the field is null, or is not (below) |
| `$like: string` | SQL `LIKE`, case-sensitive (below) |
| `$ilike: string` | the same, case-insensitive for ASCII (below) |

**`$isNull`** is how a nullable field is asked for as set or not set: an optional
field exists on every row of a model and is stored as null, so `$isNull: true`
is `IS NULL` and `$isNull: false` is `IS NOT NULL`, and the first reads the same
rows as `{ field: null }`. It applies to a relation's foreign key like any other
field, and is refused on the relation itself: `{ column: { $isNull: true } }` is
an error, because a missing parent is `{ column: null }` and a link is otherwise
filtered by its modes.

**`$like`** takes SQL wildcards: `%` matches any run of characters, `_` exactly
one, and a backslash makes the next `%`, `_` or backslash a literal. Every other
backslash is refused — at the call, and as `invalid_value` from the engine —
rather than read as the character it precedes, so a pattern that ends in a
literal backslash is written `"\\"`. It is case-sensitive: SQLite's `LIKE`
folds ASCII case and the only switch for that is a connection-wide pragma, so the
pattern is translated to `GLOB`, which compares bytes, keeping `%` and `_` as
they are. **`$ilike`** compiles to `LOWER(column) LIKE LOWER(pattern)` and folds
ASCII only: `É` and `é` do not match each other, and any non-ASCII character
compares exactly.

Both match text only, so a pattern on a number or a date field is
`invalid_value` rather than a comparison of its text form. All three
operators compose with `$and`/`$or`/`$not` and inside relation modes, and reach
live queries the same way.

### Presence

A presence room is a target of 1–128 characters from `A–Z a–z 0–9 : _ -` (a
board id, a document id). A socket holds several at once — up to the
deployment's `realtime.maxPresenceRooms`, four by default — so one connection
can show who is in each open board. Leaving one room leaves the others, and a
disconnect leaves all of them.

| Member | |
| --- | --- |
| `set(presence)` | publishes this client's presence in the room, joining it if it is new |
| `cursor(cursor)`, `drag(drag)`, `clearDrag()` | the room's pointer state |
| `peers({ includeSelf? })` | `Promise<PresencePeer[]>` |
| `subscribe(listener, { includeSelf?, onError? })` | the same list live; returns an unsubscribe function |
| `leave()` | leaves this room, and only this one |

`PresencePeer` is `{ clientId, presence, cursor?, drag? }`. The peers of a room
include your own entry, marked `isSelf: true`, so an app can draw its own cursor
without matching on names; `{ includeSelf: false }` leaves it out. Until the
socket has its `clientId` — or against a Worker that predates multiple presence
rooms — the list arrives as the server sent it. `client.clientId` is the same
id, and `undefined` until `session:ready`.

Two limits are decided before a `presence:set` is stored, and a refusal leaves
the socket's state exactly as it was. A socket's whole presence state, every
room serialised, is at most 8 KiB: past that the server answers
`presence_state_too_large`, and the same budget covers `cursor:set` and
`drag:set`. A new room past `maxPresenceRooms` answers
`presence_rooms_exceeded`; `maxPresenceRooms: 1` restores one room per socket,
and `0` refuses presence altogether.

Who may join a room is the Worker's decision:

```ts
export default defineTapeDB({
  schema,
  realtime: {
    authorize: ({ auth, kind, target, action }) =>
      kind !== "presence" ||
      target.startsWith("board:") ||
      auth.role >= WORKSPACE_ROLE_LEVELS.EDITOR,
    maxPresenceRooms: 4,
  },
});
```

`kind` is `"presence"` or `"topic"`, `target` the room or the topic, `action`
`"join"` or `"send"`, and `auth` the caller's `{ sub, role, workspaceId }`. The
answer may be a promise; anything but `true` — `false`, a throw, a rejected
promise — refuses. A presence `join` is checked before any state is stored, so a
refusal changes nothing, and a `presence:set` for a room the socket already holds
is a `send`. With no authorizer configured, anyone with a claim for the workspace
may join and send.

`topics.authorize` remains as a deprecated alias: it covers topic kinds only, and
is consulted only when `realtime.authorize` is absent, so a deployment that
configures both gets one rule set per kind. `realtime.replaySeconds` carries the
replay window `topics.replaySeconds` used to hold.

Each refusal is one `{ type: "error", code, target }` message on the socket,
which the client routes to the room's `onError`; the room keeps its last state
and the subscription carries on, so an app can explain the refusal instead of
leaving the caller to infer it from a cursor that never appears.

| Code | Meaning |
| --- | --- |
| `presence_denied` | the authorizer refused the join or the send |
| `presence_rooms_exceeded` | the socket already holds `maxPresenceRooms` rooms |
| `presence_state_too_large` | the message would take the socket's presence past 8 KiB |
| `presence_target_unknown` | a `cursor:set` or `drag:set` for a room this socket has not joined |

The wire messages are unchanged, so an old client works against a new Worker: its
second `presence:set` for another target now adds a room instead of evicting the
first, up to the cap, and it still receives its own entry as it always did. A new
client against an old Worker gets one room and no `clientId`, so `peers()` is
whatever that Worker sent.

## `@tapedb/tapedb/react` — hooks

| Hook | Returns |
| --- | --- |
| `useLive(query)` | `LiveState`: `{ data, isLoading, error }`; for an `AcrossQuery`, `AcrossLiveState` with `errors` too |
| `useLivePage(pageQuery)` | `LivePage`: `{ rows, hasMore, isLoading, error, loadMore }` |
| `usePresence(db, room, presence?, { includeSelf? })` | `PresencePeer[]`; publishes `presence` while mounted. Your own entry is included and marked `isSelf`; pass `{ includeSelf: false }` to leave it out (see [Presence](#presence)) |
| `useBroadcast(db, topic, onMessage?)` | **experimental**: a `send(message) => boolean \| "queued"` function |

## `@tapedb/react-native` — a durable queue

`AsyncStorageOutbox` and `createReactNativeClient`, and no framework bindings: React Native is a runtime,
so this package peers on `@react-native-async-storage/async-storage` (`^1.17 || ^2 || ^3`) and on nothing
else. It does not import `react-native` either, so it loads wherever JavaScript runs. The hooks are
`@tapedb/react`'s, the same module on web and on device.

```tsx
import { createReactNativeClient } from "@tapedb/react-native";
import { useLive } from "@tapedb/react";

const db = createReactNativeClient({ schema, url, workspace, userId });
```

`storage` overrides the store; `outbox` overrides the whole queue. Everything else is `createClient`'s
options. The binding contract and failure behaviour are in [Offline queue](#offline-queue).

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
| `realtime` | **experimental**: `RealtimeOptions` `{ authorize?, maxPresenceRooms?, replaySeconds? }`: one `RealtimeAuthorizer` for presence rooms and broadcast topics, the rooms one socket may hold (default 4, `0` refuses presence), and the seconds of each topic kept for a listener that reconnects (default 60, `0` keeps none) — see [Presence](#presence) |
| `topics` | **experimental**, **deprecated** alias of `realtime`: `TopicOptions` `{ authorize?, replaySeconds? }`, whose `authorize` covers topic kinds only and is consulted only when `realtime.authorize` is absent |
| `limits` | **experimental**: `LimitsOptions` `{ writes?: { models?: { [model]: { count, windowSeconds } }, workspace?: { count, windowSeconds } } }` — per-model and per-workspace write budgets, see [Write budgets](#write-budgets) |
| `webhooks` | **experimental**: `readonly WebhookOptions[]` — signed change events to an endpoint, captured inside the write's transaction and delivered after the commit |
| `vectorize` | `VectorizeOptions` `{ index, model, field, filterFields?, embed?, keywordFields?, rerank? }` — mirrors one model's `t.vector({ dimensions })` attribute into a Vectorize index; see [Vector search](#vector-search) |
| `http` | **experimental**: `HttpApiOptions` `{ token }` — the admin HTTP API (`POST /v1/query`, `/v1/transact`, `/v1/claim`) for a backend server. `token` is the shared secret such a caller sends, at least 32 bytes: a string, refused when the Worker is defined if it is shorter, or `(env) => env.TAPEDB_API_TOKEN`, the form a deployment uses. Absent, the paths answer 404 — see [Admin HTTP API](#admin-http-api) |

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
`TopicAction`, `TopicAuthorizer` and `TopicGap` are **experimental**, and so are
`RealtimeOptions`, `RealtimeAuthorizer`, `RealtimeAuthorizeContext` and
`RealtimeKind`, and `LimitsOptions`, `WriteLimitsOptions` and `WriteLimit`, and
`HttpApiOptions` and `HttpApiToken`. The vector types are **experimental** too:
`VectorizeOptions`, `VectorIndex` (the four operations this engine uses),
`VectorRecord`, `VectorIndexMutation`, `VectorQueryOptions`, `VectorQueryResult`,
`VectorMatch` and `VectorIndexDescription`.

### Write budgets

```ts
defineTapeDB({
  schema,
  limits: {
    writes: {
      models: { task: { count: 60, windowSeconds: 60 } },
      workspace: { count: 600, windowSeconds: 60 },
    },
  },
});
```

A budget is `count` writes per `windowSeconds`, counted in **fixed windows**:
the window opens on the first write charged to it, and the counter starts again
at zero when it closes. The burst this allows is the fixed-window one — a caller
can spend a whole budget as one window closes and another immediately after, so
up to `2 × count` writes in one window's span. It is not smoothed, and nothing
here claims it is; the arithmetic is one row per budget, so what it does is
checkable.

- **Per model**: one unit per write operation on that model, by API name. A
  bulk `patchMany`/`deleteMany` is **one** operation: its rows are only known
  inside the transaction that applies them.
- **Workspace-wide**: `workspace` counts every operation across every model, so
  it is the backstop under per-model budgets. Both are checked before the write
  is applied.
- **A rejected write spends nothing.** The envelope is validated first, so a
  write the engine would refuse never reaches the counter, and a write that
  fails inside the transaction (`unique_violation`, a row rule) returns its
  charge. A retry carrying a `clientTxId` that already applied is not charged
  again.
- **Durable**: the counters are rows in the workspace's own SQLite
  (`_write_limits`), so eviction, hibernation and a Worker restart keep them. A
  budget held in memory would protect nothing. They are not part of the log, so
  a workspace rebuilt from R2 after its storage was lost resumes with empty
  counters.
- **Off by default**: without `limits` no table is created and the write path
  pays one check.

A refusal is the usual transaction error envelope, `429`, with `Retry-After`
set to the same whole seconds the body carries:

```json
{ "ok": false, "error": {
  "code": "rate_limited",
  "message": "The \"task\" model allows 60 writes per 60 s; this write would exceed it. Retry in 12 s.",
  "model": "task", "limit": 60, "windowSeconds": 60, "retryAfterMs": 11840
} }
```

`model` is `"workspace"` for the workspace-wide budget. The client already
treats a `429` as retryable, so a queued offline write stays queued and is sent
after the window rather than being dropped.

### Vector search

```ts
defineTapeDB({
  schema,
  vectorize: {
    index: "VECTORIZE",          // the binding's name in Env
    model: "note",
    field: "embedding",          // note.embedding: t.vector({ dimensions: 768 })
    filterFields: ["archived"],  // copied into the vector's metadata
    embed: { binding: "AI" },    // optional: lets a caller search with words
    keywordFields: ["title", "excerpt"],  // optional: exact-term recall
    rerank: { binding: "AI" },            // optional: cross-encoder reordering
  },
});
```

The option mirrors **one** vector attribute of **one** model into **one**
Vectorize index. `index` names the binding, so a deployment without this option
needs neither the option nor the binding: no table is created, no binding is
read, nothing is written. `model` and `field` are checked against the schema
when the Worker is defined, together with these rules:

- `field` must be a `t.vector({ dimensions })` attribute, and its declared
  dimensions are the index's: 1 to 1,536, the same declaration and the same
  validator the field itself uses;
- a `filterFields` entry must be a `string`, `number` or `boolean` attribute of
  that model — a `json`, `date` or vector attribute has no metadata index to
  filter on;
- a `filterFields` entry must not be personal: metadata is stored at the
  provider, which is a copy outside the workspace's storage;
- at most **ten** filter fields, the provider's ceiling of ten metadata indexes
  per index.

`embed` is optional and is what makes a text query possible. `binding` names a
Workers AI binding in `Env` and `model` is an embedding model, defaulting to
`@cf/baai/bge-base-en-v1.5`. The model's output length must be the field's
declared dimensions, which this build checks for every model it knows
(`bge-small-en-v1.5` 384, `bge-base-en-v1.5` 768, `bge-large-en-v1.5` 1024,
`bge-m3` 1024); an unknown model is accepted and checked by the provider at the
first text query. Without `embed`, callers send vectors they computed
themselves, which is what a pipeline that embeds its corpus already does.

A worker that fails any of these refuses to start, naming the option, rather
than discovering it at the first write. Once a room is running, the index's own
`dimensions` and metric are compared with the schema before the first
submission: an index of another shape is refused, the intents stay queued, and
`/status` keeps counting them.

**Deploying the index.** The deployment declares what it indexes in
`tapedb.vectorize.json`, and `tapedb deploy` provisions the index before it
uploads the Worker:

```json
{ "model": "note", "field": "embedding", "filterFields": ["archived"] }
```

It is its own file rather than a key in `wrangler.jsonc` because Wrangler
validates that file and warns about every field it does not know, so a correct
project would print a warning on every deploy.

The declaration is validated against `tapedb.schema.ts` first — the field must
be that model's `t.vector({ dimensions })` attribute, filters must be flat,
non-personal scalars, at most ten — and the index is named from deployment
identity, `tapedb-<worker>-<model>`, lower-cased and trimmed to the provider's
64-byte ceiling. A repeat deploy, two concurrent deploys and a retry after a
failed upload therefore converge on one index rather than creating more. On a
first deploy the CLI creates the index and one metadata index per declared
filter, records `index` and `ownership` in `tapedb.vectorize.json`, and adds the
binding the Worker reads to `wrangler.jsonc`:

```jsonc
"vectorize": [{ "binding": "VECTORIZE", "index_name": "tapedb-app-note" }]
```

On every later deploy it reads the live index and refuses to upload when
anything disagrees with the record or the schema: another dimension count,
another metric, a metadata index of the wrong type, an ownership record naming
another account or worker. Nothing is deployed in that case, and the message
names both values. An index that exists without an ownership record is refused
rather than adopted silently; if it is yours, record it with
`"index": "tapedb-app-note"` under `tapedb.vectorize` and deploy again.

A deployment restricted to `eu` or `fedramp` refuses vector search before
provisioning anything: Vectorize cannot meet that residency, and an index
created in the wrong jurisdiction cannot be redeployed out of it. Removing the
`tapedb.vectorize` block generates no binding and touches no index.

**What is published.** Each indexed row becomes one vector: the stored
`f32le:v1:<base64>` bytes of the field, the configured filter values, and a
**digest**. The vector ID is `hex(SHA-256(deployment, workspace, model, field,
row id))` — exactly 64 characters — and the namespace is
`base64url(SHA-256(deployment, workspace))` — 43 characters — both derived, never
supplied, so one workspace cannot address another's vectors and neither an ID
nor a metadata value carries a note, a workspace ID or an identity.

**The digest** is what decides whether a row is published again. It is the
SHA-256, as 64 hex characters, of a string containing, in order:

1. `tapedb.vector.digest/1` — the rule's version;
2. the codec tag (`f32le:v1:`) — a value written by another codec is another
   state, even if it decodes to the same numbers;
3. the model's API name and the row ID;
4. the vector's **decoded canonical bytes** — decoded and re-encoded through the
   one codec first, so two JavaScript inputs that round to the same float32 are
   one state, and `-0` and `+0` are one state;
5. every filter value, sorted by attribute name, each as `<name>` and a typed
   value: `b0`/`b1` for a boolean, `n:<json>` for a number, `s:<json>` for a
   string, `absent` for a field that is null or missing.

The filter values are in it for a specific reason: the provider evaluates a
metadata filter before ranking, so if `archived` goes from `false` to `true` and
nothing is re-sent, the row keeps matching `{ archived: false }` and is stale in
the index while SQLite says otherwise. Hashing the filters makes that write
publish again, and hashing the canonical bytes makes a write that changes
nothing cost nothing — an unchanged digest is never re-sent.

**The queue.** The intent is captured **inside the write's transaction**, by a
trigger on the indexed model, into `_vector_queue` in the workspace's own
SQLite, keyed by `(model, row id)`: ten writes to one row in one transaction
leave one intent, and a delete after an insert leaves a delete. The row and its
intent commit together, so indexing can never fail or slow a commit — with the
index unreachable, the write commits, reads succeed, and the intent waits.

The intent is drained from the **durability alarm**, the same mechanism that
flushes the log to R2, never from a request. A drain submits the oldest due
upserts in one batch of up to **1,000 vectors** (the provider's ceiling for the
Workers binding; its HTTP API takes 5,000, which this engine does not use) and
the oldest due deletes in one batch of up to **1,000 IDs** — the limits page
documents no delete ceiling for the binding, so deletes use the figure it does
document. A submission that fails keeps every intent in its batch, increments
`attempts`, and schedules `next_attempt_at` from the same capped exponential
backoff the log flusher uses: 30 s, doubling, capped at one hour. An intent is
never dropped for failing, and a retry always re-reads the row's current state
first, so a row written again during a backoff is published with its latest
values. After twelve failed attempts an intent stops being retried and is
reported as **dead-lettered**: it stays in the workspace, counted, so an outage
that outlasts the backoff is visible instead of silently retrying forever.

**Pending is normal.** The provider accepts a submission asynchronously and its
vectors become searchable later: measured on a live index, an accepted upsert was
visible 73–103 s afterwards. This engine records the mutation ID the provider
answers with and treats `pending` as the ordinary state of a fresh row. It does
not poll per request, does not block a write on visibility, and does not treat
the provider's `processedUpToMutation` as progress: it is not monotonic across
replicas, so no confirmation may assume it moves forward. `GET /status` reports a
count instead:

```json
{
  "vectorize": {
    "pending": 3, "failing": 1, "deadLettered": 0, "indexed": 412,
    "lastMutationId": "01J...", "fenced": false, "purge": null,
    "rebuild": null
  }
}
```

`pending` is the queue depth, `failing` the intents whose last attempt was
refused, `deadLettered` the intents that stopped being retried, and `indexed`
the rows the provider has accepted a digest for. `fenced` is true while the
workspace's erasure marker stands, and `purge` carries the erasure's phase when
one exists — the three work states are separate on purpose, because "waiting",
"failing" and "will not be retried" call for different answers, and because an
erasure that is stuck is otherwise indistinguishable from a busy queue.
`rebuild` is the job described below, or null.

**Deletes.** Deleting a row enqueues a delete of its vector, and clearing the
vector field does the same; both are submitted like any other intent and are
idempotent at the provider. Deleting an ID the index does not hold is not an
error, so a delete is always queued rather than inferred from local state — an
upsert whose answer was lost may still have reached the provider.

**Hybrid recall.** `keywordFields` names up to five string attributes of the
indexed model. Their text is mirrored into an FTS5 table in the workspace's own
SQLite by triggers inside the write's transaction, so it is written, changed and
deleted with the row and never waits for the provider. A text query then has two
halves: the vector candidates from the index, and `bm25` candidates from that
table, merged by reciprocal rank. The keyword half needs `embed` (there is no
text query without it), refuses to index a personal field, and indexes only
strings. Its hits are filtered by the same `filter` and read through the same
access rules, and a hit is kept only for a row that has an embedding.

The two sides disagree in useful ways. A row whose text changed after its vector
was published is dropped from the vector side by the version gate, but the
keyword hit is on the current row, so it stays. A part number, an acronym or a
name the embedding blurs is found exactly. And because the keyword side is local,
a row written a second ago is findable by its exact words while its vector is
still pending.

`rerank` adds a cross-encoder pass over the answer's candidate window:
`@cf/baai/bge-reranker-base` by default, scoring each candidate's passage (the
`keywordFields`) against the question. Its order replaces the fused one and its
relevance becomes the score, so a reranked answer's score is not comparable with
an unreranked one; `search.reranked` says which you got. A reranker that fails
or answers the wrong number of passages leaves the retrieval order in place and
reports `reranked: false`, because a less well ordered answer beats no answer.
`rerank` requires `keywordFields` (it reads the passage text) and `embed` (it
scores words), and only a text query is reranked: a vector has no words to read.

`search.mode` says which ranking produced the answer: `vector` means the index
alone and `score` is the provider's cosine similarity; `hybrid` means the two
lists were fused and `score` is the fused rank. A fused score is comparable
within one answer only, never across modes.

**Searching.** `db.note.search({ vector })` asks the index for candidates and
answers with the rows this workspace still holds:

| option | |
| --- | --- |
| `vector` | the query embedding: the numbers a write takes, the field's declared length. Another length is refused with the message a write gives (`invalid_value`). |
| `text` | the query in words, embedded by the deployment's `vectorize.embed` binding through the same model that embedded the corpus, so a caller never runs that model itself. `text` and `vector` are alternatives: sending both is refused (`invalid_value`), and so is `text` on a deployment with no `embed`. An empty or non-string `text` is refused before the binding is called; an embedding binding that fails answers `storage_error` with retry guidance rather than an empty result. |
| `limit` | matches to return, 1 to 50. Defaults to **10**. A larger number is **refused** (`invalid_value`), never clamped: a caller who asked for 200 and got 50 would read the answer as "this is all there is". |
| `filter` | equality on the deployment's `filterFields` only, each value typed as its attribute (a string, a number or a boolean). An attribute the deployment did not declare is refused (`invalid_value`) rather than matched against nothing, because the index carries no metadata for it. Applied before the ranking, so a filtered search returns `limit` matches rather than whatever survives a filter over an unfiltered ranking. |
| `where` | the same filter a read takes, applied to the rows the index returned. |
| `select` | fields to return, as a read's `select`. The embedding is never returned, even when it is named. |

The result is `{ rows, truncated }`: rows nearest first, each carrying `score`.
A score is cosine similarity from -1 to 1 — 1 is the same direction as the
query — as the provider computed it: not a percentage, not a distance, and only
meaningful for ranking rows within one answer. `truncated` is true when the index
answered with as many candidates as the limit asked for, so matches may rank
below the last row returned; false means the index had nothing more to give.

The index is a cache of earlier writes, so a search never answers with what it
returned. Every candidate is re-read from the workspace's own SQLite through the
same path a `findMany` takes, so `view` rules, `where` rules and row-level rules
apply exactly as they do to a read. An id the database no longer holds is
dropped; so is a row whose embedding or filter value changed after it was
indexed, because its vector in the index describes a state the row no longer
has. Neither drop is an error, and neither is reported: a row the caller may not
see is indistinguishable from one that does not exist, so a search that finds
nothing answers with no rows and a caller who is allowed nothing gets the same
shape of answer as one who matched nothing.

A search is not live and is not cached: it is one provider query and one SQLite
read per call, and the answer ages the moment it is sent. A row written a moment
ago is not searchable until the queue's upsert has been accepted and has become
visible at the provider — 73–103 s, measured.

**The operator's surface.** Three admin-or-owner routes answer for one
workspace's index. An ordinary member is refused with `403 insufficient_role`
before anything else, so the answer cannot tell them whether vector search is
configured at all.

`POST /search` answers `search: { scores, truncated, mode, reranked }`, where
`mode` is `vector` or `hybrid` as described above and `reranked` says whether a
cross-encoder decided the order.

| route | | |
| --- | --- | --- |
| `POST /vector/retry` | requeues every intent whose last attempt failed, including dead-lettered ones. Nothing about what the provider is expected to hold changes: the next drain recomputes each row from current state, so a retry after a fix sends the row as it is now. Answers `{ requeued, pending, failing, deadLettered, indexed }`. |
| `POST /vector/rebuild` | starts a rebuild, or returns the one already running: one job per workspace, so two operators asking at once get one `jobId` (`started: false` on the second). Answers `{ jobId, started, active, phase, enqueued }`. |
| `POST /vector/rows` | `{ model, ids }`, 1 to 100 ids. Answers `{ model, rows: [{ id, status }] }` for rows the caller may read, where status is `unindexed` (no embedding stored), `pending` (queued, not yet accepted), `indexed` (the accepted digest is the row's current one) or `failed` (stopped retrying). A row the caller may not see, or one that does not exist, is simply absent — the two are indistinguishable, as they are from a read. |

A rebuild is a workspace-scoped job kept in the workspace's own SQLite, not a
process: it prepares by forgetting what the provider accepted (so every row is
sent again) and turning accepted digests whose row is gone into deletes, then
enqueues rows in bounded batches, then verifies the queue is empty. The Durable
Object can be evicted between batches and the job resumes from its cursor. While
it runs, search for that workspace answers `503 vector_search_unavailable` with
`retry-after: 30`, because a half-built index would rank on a state the database
no longer has. `GET /status` reports the job under `vectorize.rebuild`, so a
refused search has a visible cause. Retry and rebuild are logged as
`workspace_vector_rebuild`; neither logs a vector, a note or a claim.

**Erasing a workspace.** `DELETE /` erases the workspace's vectors as part of
erasing the workspace. The flow is fence → drain → delete → verify, and each
step is durable before the next one depends on it.

*The fence.* A marker is written to the deployment's own `DATA` bucket at
`vector-purge/<deployment>/<workspace>/marker.json` before any delete is issued,
and it is never removed: it is the tombstone that rejects resurrection. While it
stands, no submission begins for that workspace — not a fresh intent, not a
retry recovered from `_vector_state` in a room that was evicted and re-created,
not a restore, not a rebuild. The marker is read immediately before each
submission, and that read and the start of the submission are one serialised
step: a fence written while a batch is in flight waits for that batch, and
nothing begins after it. An erase whose marker cannot be written deletes nothing
and answers `erase_failed`.

*The delete.* The inventory is read from the workspace's own `_vector_queue` and
`_vector_state` before its storage is wiped, so an ID whose row was deleted from
SQLite long ago is included and an upsert whose answer was lost is covered. IDs
go out in batches of up to **1,000**, the same ceiling row deletes use, each
batch its own immutable object under `vector-purge/<deployment>/<workspace>/ids/`.

*The confirmation.* A batch is confirmed only when the index reports **the
mutation ID that batch's own delete was accepted under**, or one this purge
submitted after it. Nothing compares the watermark over time: it is
replica-inconsistent and was observed going *backwards* between two reads, so
"it advanced" says nothing, and a watermark that matches no mutation this purge
recorded — another workspace's submission on a shared index, or a replica
behind — confirms nothing. A confirmation, once recorded, is never withdrawn.
`getByIds` is not used as evidence at all. Its answer arrives on the same
asynchronous path an accepted upsert took 73–103 s to appear on, so an ID
missing from it says nothing about the watermark having reached that delete,
and an ID present says nothing about it not having been issued. The watermark is
the only clock this purge reads, and only for the mutation IDs it recorded.

*Interruption.* `vector-purge/<deployment>/<workspace>/ledger.json` is the
durable truth: the fence's time, the inventory's batches, each batch's mutation
ID, attempts, backoff and confirmation. An erasure interrupted at any step
resumes from that ledger — after the Durable Object, its storage or its alarm is
gone — whenever a room for that workspace runs again, which is what
`resumeVectorPurge()` does and what an erased workspace's own alarm does. Until
every batch is confirmed the erasure is reported as outstanding rather than
complete. A batch that fails twelve times stops retrying and is reported as
stalled with its error in the ledger.

*What an operator sees.* `DELETE /` answers with the purge's phase; a phase that
is not `complete` logs `workspace_vector_purge` with the number of IDs and of
confirmed and pending batches. The ledger is readable in the bucket without the
workspace: `phase`, `ids`, per-batch `mutationId`, `attempts` and `confirmedAt`,
`lastError` and `completedAt`. `GET /status` carries the same status as
`vectorize.purge` for a workspace that still answers, including `fenced` — a
workspace whose fence stands with an empty ledger is a purge that has not
started, which is what an operator needs to be able to see.

*Restore.* A backup restored into a workspace — the same ID, or
`tapedb restore --into` another — is re-indexed under the **destination**
identity: the ID and the namespace are derived from the destination's workspace
ID, so nothing is ever written under the source's, and a copy cannot revive an
ID that was erased. The restore names the workspace it came from, and that
source is checked before anything is published: when the source's marker stands,
its rows import and no vector is written for them. Bookkeeping that names another
identity — a `_vector_queue` or `_vector_state` copied from another workspace —
is discarded when the room boots, and every surviving row is re-derived locally.
A same-ID restore and a restore-as-copy reach the same rule, because it is stated
about the identity an ID is derived from rather than about the workspace ID a
request happens to carry.

**Limits and what is not here.** Filter strings are truncated to the provider's
64-byte indexed-string budget on a UTF-8 boundary when copied into metadata; the
digest covers the untruncated value. Metadata indexes must exist *before* the
vectors they index — adding a filter field later means re-publishing every
vector, which this release does not do on its own. A purge deletes the vectors
this deployment wrote for the workspace; it does not inventory the provider, so a
vector written under that identity by something other than this engine is out of
scope.

### Bindings and settings (`Env`)

| Name | Kind | |
| --- | --- | --- |
| `WORKSPACE` | Durable Object namespace | class `WorkspaceRoom` |
| `DATA` | R2 bucket | log segments and snapshots |
| `FILES` | R2 bucket, optional | uploads |
| `VECTORIZE` | Vectorize index, optional | the index `vectorize.index` names; read by name, so any binding name works |
| `TAPEDB_CLAIM_SECRET` | secret | HS256 key for claims, at least 32 bytes |
| `TAPEDB_KEY_SECRET` | secret | stable wrapping and HMAC key for personal fields; required when the schema has personal fields |
| `TAPEDB_CLAIM_ISSUER`, `TAPEDB_CLAIM_AUDIENCE` | var, optional | checked when set |
| `ENVIRONMENT` | var | `production` refuses the development claim route |
| `TAPEDB_MOVE_FROM` | var, optional | source jurisdiction while moving: `none`, `eu` or `fedramp`; pair with `DATA_FROM` and `FILES_FROM`, and `WORKSPACE_FROM` for a different namespace |
| `TAPEDB_JURISDICTION` | var, optional | `eu` or `fedramp`; relocate existing workspaces with `tapedb move` |
| `TAPEDB_DEV_CLAIMS` | var or secret | development claim route on; never in production |
| `TAPEDB_DEV_CLAIMS_TOKEN` | secret, optional | the development claim route then needs `x-tapedb-dev-token` |
| `AI` | Workers AI binding, optional | the model `vectorize.embed.binding` names, used to embed a `text` query; without it a text query answers `503 vector_search_unavailable` |

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
| `POST /engine/workspaces/:id/search` | `{ model, vector, limit?, filter?, where?, select? }` → `{ ok, data: { <model>: rows }, search: { scores, truncated } }`; see [Vector search](#vector-search). 503 `vector_search_unavailable` while that workspace's index is being rebuilt |
| `POST /engine/workspaces/:id/vector/retry` | ADMIN or higher; requeue failed and dead-lettered index work for this workspace → `{ ok, data: { requeued, pending, failing, deadLettered, indexed } }` |
| `POST /engine/workspaces/:id/vector/rebuild` | ADMIN or higher; start or join this workspace's one rebuild job → `{ ok, data: { jobId, started, active, phase, enqueued } }` |
| `POST /engine/workspaces/:id/vector/rows` | `{ model, ids }` → `{ ok, data: { model, rows: [{ id, status }] } }` for rows the caller may read; status is `unindexed`, `pending`, `indexed` or `failed` |
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

### Admin HTTP API

A backend — a queue consumer, a cron job, your own API — can read, write and
mint claims for a workspace without holding a browser socket. It is one option
and three routes, off by default:

```ts
import { defineTapeDB } from "@tapedb/tapedb/worker";

export default defineTapeDB({
  schema,
  http: { token: (env) => env.TAPEDB_API_TOKEN },
});
```

`token` is at least 32 bytes, the same rule `TAPEDB_CLAIM_SECRET` follows; a
literal string is refused when the Worker is defined, and the function form is
refused on the request that reads it (`500 api_token_misconfigured`). Store it
as a secret (`wrangler secret put TAPEDB_API_TOKEN`); the variable's name is
yours to choose.

**Off by default.** Without `http` these three paths answer `404 no_route`,
like any other unknown path, so an API a deployment did not enable cannot be
found by probing for it.

Callers send `authorization: Bearer <token>`. The token is compared in
constant time, before the body is read and before a workspace is addressed, and
it never appears in a response. A missing or wrong token is `401
unauthorized`; so is an engine claim presented in that header — the two secrets
are different.

| Route | |
| --- | --- |
| `POST /v1/query` | `{ workspace, as: { sub, role }, query }` → `{ ok, data, pageInfo }`: the answer the same read gives over the socket |
| `POST /v1/transact` | `{ workspace, as: { sub, role }, writes, clientTxId? }` → `{ ok, result }`. `writes` is the transaction's `ops` array; `clientTxId` makes a retry a replay rather than a second write |
| `POST /v1/claim` | `{ workspace, as: { sub, role } }` → `{ token, workspaceId, roleLevel, expiresAt, expiresIn }`: a claim for that subject, to hand to a client |

`workspace` must be a workspace id (a UUID); anything else is `400
invalid_workspace_id`, answered before a Durable Object is addressed. `as` is
validated like any claim: `sub` non-empty and at most 256 characters (`400
invalid_sub`), `role` a whole level from 0 to 8 (`400 invalid_role`), and the
object itself `{ sub, role }` (`400 invalid_as`).

**`as` is an identity, not a privilege.** Every request names who it acts as,
and the engine evaluates the rules for that identity exactly as it does for a
socket holding that claim: role levels, `filter` view rules, `check` write
rules, file rules. Nothing is bypassed — a backend acting as `admin` still
fails a rule that denies admins, and a `filter` rule still hides the rows that
subject may not read. That is deliberate: an admin claim that skipped the rules
would make one leaked token read every row of every workspace and turn the
rules a deployment wrote into documentation instead of enforcement.

Writes go through the same pipeline as a client's: validation, rules, the
`limits.writes` budget, the log, webhooks and live-query invalidation.
`POST /v1/transact` spends the budget like any other write, and a refusal is
the same `429 rate_limited` with `Retry-After` (and `model`, `limit`,
`windowSeconds`, `retryAfterMs` in the body) — the admin API is not a way
around the limits, and a budget it exhausts refuses the socket path too.

The claim `/v1/claim` mints is an ordinary claim: a client holding it reaches
exactly the routes its role allows. Minting needs `TAPEDB_CLAIM_SECRET` and
honours `TAPEDB_CLAIM_ISSUER` and `TAPEDB_CLAIM_AUDIENCE` when they are set.


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
`realtime.replaySeconds`, default 60, at most 1,000 per topic; engine
migration `tapedb_0009_topic_buffer`).

A socket's live queries, presence and topics are kept in its attachment
while they fit (12 KiB) and in the workspace's storage past that (engine
migration `tapedb_0007_socket_state`), so a socket may hold any number of
queries and topics; presence rooms are the exception, capped at
`maxPresenceRooms` and budgeted together at 8 KiB. The protocol belongs to the
client; use it directly only if you must.

## CLI

`npx tapedb-cli init | migrate dev|rollback|status|check|squash | dev | studio |
deploy | export | backup | restore | seed | erase | move`. The exact commands
and flags are in `npx tapedb-cli --help`
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

### Backup and restore

`tapedb backup --workspace <uuid> --out <dir> [--url <worker>] [--dry-run]`
writes one workspace as a directory. The workspace comes from `--workspace` or
`TAPEDB_WORKSPACE`, the claim from `--token`, `TAPEDB_TOKEN` or the development
claim route, as `export` does.

| Path | Holds |
| --- | --- |
| `backup.json` | `format` `"tapedb-backup"`, `version` 1, the workspace, `seq`, the row count and per-model counts, the models, the schema version, and `parts`: every other file with its byte length and its sha256 |
| `rows.ndjson` | `GET /engine/workspaces/:id/export` saved as it streams, so the `header`, `row`, `file` and `end` records are the engine's own bytes |
| `files/<path>` | the bytes of each file the export names, through the file route with the same claim |

The export must be consistent: a workspace that took writes while it streamed is
refused, because import would refuse it too. A directory that already holds a
`backup.json` is not overwritten, and a run that fails removes what it wrote, so
an interrupted backup is never mistaken for a good one. `--dry-run` streams and
hashes the same records and prints the counts, and writes nothing at all — not
the directory, not a partial file.

`tapedb restore --from <dir> [--into <uuid>] [--url <worker>] [--dry-run]`
checks every part against `backup.json` — its length and its sha256, and that a
rows part is named — before anything is written or sent, so a tampered or
truncated backup is refused with the destination untouched. It then posts the
rows through `POST /engine/workspaces/:id/import`, which preserves row
timestamps, and uploads each file's bytes through the file route, so the index
and the R2 keys are rebuilt for the destination instead of copied from the
backup. `--into` names the destination and defaults to the workspace the backup
came from.

The destination must be empty: one that already holds a row or a file is refused
before the import, so running the same restore twice is a clean error rather than
a second copy, and an erased workspace (410) needs a new one via `--into`.
`--dry-run` verifies every part and prints the counts and hashes, and writes and
sends nothing. A restore whose import reports a different row count from the
manifest exits 1 and names both numbers.

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
| `rate_limited` | 429 | a claim limit or `identity.allowRequest` refused a claim request, or a write budget (`limits.writes`) refused a write; `Retry-After` is set, and a write budget's error also carries `model`, `limit`, `windowSeconds` and `retryAfterMs` |
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
| `unauthorized` | 401 | the admin HTTP API's bearer token is missing or wrong (see [Admin HTTP API](#admin-http-api)) |
| `invalid_as` | 400 | the admin HTTP API's `as` is not `{ sub, role }` |
| `api_token_misconfigured` | 500 | `http.token` resolved to nothing, or to fewer than 32 bytes |
| `jurisdiction_mismatch` | 500 | the Worker reached a room outside `TAPEDB_JURISDICTION` |

Socket refusals use their own codes rather than a status: `presence_denied`,
`presence_rooms_exceeded`, `presence_state_too_large` and
`presence_target_unknown` (in [Presence](#presence)), plus `invalid_target`,
`invalid_presence`, `invalid_cursor`, `invalid_drag` and `part_out_of_order`
for a malformed message.

A presence refusal is delivered to the room's subscriber through `onError`,
as `{ code, target }`. The room keeps its last state and the subscription
carries on, so the callback is how an app explains the refusal instead of
leaving the caller to wonder why their cursor never appeared.

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
