# tapedb — scope contract

A typed database for Cloudflare, shipped as a library that provisions itself
into the consumer's own account. Prisma's job, on Cloudflare's primitives,
with live queries and offline writes because the engine is built for them.

**Definition.** One SQLite database per workspace lives inside a single
Durable Object. Every write is appended to a transaction log, the log ships
to R2 and is replayed on cold start. Clients read through typed model
queries, awaited once over HTTP or subscribed live over one WebSocket, with
an optimistic cache and a durable outbox.

**Not a BaaS.** tapedb owns no identity, no billing, no hosted control plane.
It consumes a verified claim and never issues one. Owning passwords is the
line it never crosses.

## The surface

| Area | What ships |
| --- | --- |
| Schema | `schema()` / `model()` / `t` builders; relations via `belongsTo` / `hasMany`; defaults, indexes, unique; types inferred, no codegen |
| Reads | `findMany`, `findFirst`, `findUnique`, `findPage` (keyset), `count`; `where` with `not/in/notIn/gt/gte/lt/lte/AND/OR/NOT`; `include` to depth 2 |
| Live | `.subscribe()` on any query; `useLive`, `useLivePage`, `usePresence`; per-model invalidation, 50 ms batching, row diffs; counts live via page metadata |
| Writes | `create` (strict), `update` (strict), `upsert`, `delete`, `connect`/`disconnect`, `$transaction`; optimistic, offline outbox, exactly-once within the dedupe window |
| Access | `role()` levels, `filter()` read rules compiled into SQL, `check()` row rules inside the transaction |
| Migrations | committed SQL diffed from the schema; change declarations for replay; applied per Durable Object on wake; engine track separate from the app's |
| Durability | NDJSON log segments + chunked snapshots to R2; idempotent cold-start replay, across schema changes; local log trimmed to R2's window |
| Files | `db.$files` upload/list/download/delete; bytes in R2, index through the log; 25 MB cap |
| Presence | `db.$presence(room)`: presence, cursors, drag; ephemeral, same socket |
| Identity seam | `defineTapeDB({ identity })` serves `POST /_tapedb/claim`; dev claims refused in production |
| CLI | `init`, `migrate dev/status/check`, `dev`, `studio`, `deploy` (guarded) |

## Infrastructure footprint

Exactly three resources, created by `tapedb init`, unconditionally: one
Durable Object class, R2 bucket `DATA` (log and snapshots), R2 bucket `FILES`
(uploads). No D1. Memberships and sessions belong to the consumer's identity
system; the engine reads one header.

## Non-negotiables

1. **Out of the box.** One install, one command, three resources. No
   capability flags, no optional packages. The library ships its own Worker
   entry.
2. **The core has zero runtime dependencies.** React appears only in
   `tapedb/react`. `dist/index.js` contains no engine code.
3. **One Durable Object class.** Presence rides the database socket.
4. **No UI ships.** `tapedb studio` is a local dev tool, not a component.
5. **The write path is HTTP, the read path is the socket.** Documentation
   never says "realtime transactions over WebSocket".
6. **Fail closed.** A broken access rule hides or denies; an unsupported
   filter operator is an error, not a match-all; undeclared schema drift
   stops recovery rather than guessing.
7. **Exactly-once is a stated window, not a vibe.** Retries the engine cannot
   vouch for are refused (`dedupe_expired`), never silently re-applied.

## Out of scope

Permanently: application UI (kanban, whiteboards, canvases), collaborative
text documents (CRDTs/Yjs), theming, i18n, auth providers, billing, teams,
emails, webhooks — these belong to the host app.

Out of v1, could earn their way in later: `select` projections, aggregates
beyond `count`, `updateMany`/`deleteMany`, nested `create`, broadcast topics,
a user-facing export API, a hosted devtool.

## Known trade-offs

- **Function `read` rules are scan-capped.** They run after fetch, reading at
  most `max(limit * 10, 200)` rows per page, so a rule that hides almost
  everything can return a short page, and `count` is refused under one.
  `filter()` rules have none of these limits; prefer them.
- **The dedupe window is finite.** After a restore, idempotency keys reach
  back `DEDUPE_HORIZON_SEQ` (2000 seq) past the snapshot base; the local log
  is trimmed to the same window. Older retries get `dedupe_expired` and the
  app decides. Carrying keys inside snapshots would remove the window at the
  cost of a format that grows with history.
- **The live `loadMore` window caps at 1000 rows per model** (the engine's
  limit ceiling). Past that, a reconnect restores 1000 rows and paging
  resumes by cursor.
- **Rebuilding a referenced table is refused.** SQLite cannot disable foreign
  keys inside the migration's transaction, so a type change on a table other
  tables reference must be done as add-copy-drop in the app.
- **`include` depth is 2**, and nested levels are not paginated; a cursor is
  only defined for the top level's order.
- **Relation filters go two links deep**, and the types follow one. A second
  hop is accepted and checked by the engine, not by the editor: typing both
  hops means resolving the model graph into itself for every key, which runs
  the type checker out of memory on models that point at each other.
- **Log segments written by current builds are not replayable by pre-0.1
  builds** (file-index entries, strict ops). Pre-1.0, noted in release notes.
