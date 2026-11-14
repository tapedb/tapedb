# TapeDB architecture

TapeDB runs in the application owner's Cloudflare account. Its schema, client,
Worker and migration tooling share one typed model definition.

**Definition.** One SQLite database per workspace lives inside a single
Durable Object. Every write is appended to a transaction log, the log ships
to R2 and is replayed on cold start. Clients read through typed model
queries, awaited once over HTTP or subscribed live over one WebSocket, with
an optimistic cache and a durable outbox.

The application supplies identity through the claim adapter. TapeDB verifies
workspace claims when serving reads, writes and subscriptions.

## Package entry points and runtime

| Area | Responsibility |
| --- | --- |
| Schema | `schema()` / `model()` / `t` builders; relations via `belongsTo` / `hasMany`; defaults, indexes, unique; types inferred, no codegen |
| Reads | `findMany`, `findFirst`, `findUnique`, `findPage` (keyset), `count`; `where` with `not/in/notIn/gt/gte/lt/lte/AND/OR/NOT`; relation includes |
| Live | `.subscribe()` on any query; `useLive`, `useLivePage`, `usePresence`; per-model invalidation, 50 ms batching, row diffs; counts live via page metadata |
| Writes | `create` (strict), `update` (strict), `upsert`, `delete`, `connect`/`disconnect`, `$transaction`; optimistic, offline outbox, transaction idempotency |
| Access | `role()` levels, `filter()` read rules compiled into SQL, `check()` row rules inside the transaction |
| Migrations | committed SQL diffed from the schema; change declarations for replay; applied per Durable Object on wake; engine track separate from the app's |
| Durability | NDJSON log segments + chunked snapshots to R2; idempotent cold-start replay, across schema changes; local log backed by R2 |
| Files | `db.$files` upload/list/download/delete; bytes in R2, index through the log |
| Presence | `db.$presence(room)`: presence, cursors, drag; ephemeral, same socket |
| Identity seam | `defineTapeDB({ identity })` serves `POST /_tapedb/claim`; dev claims refused in production |
| CLI | `init`, `migrate dev/status/check`, `dev`, `studio`, `deploy` (guarded) |

## Infrastructure footprint

The generated Worker configuration declares three resources: one
Durable Object class, R2 bucket `DATA` (log and snapshots), R2 bucket `FILES`
(uploads). No D1. Memberships and sessions belong to the consumer's identity
system; the engine reads one header.

## Request flow

HTTP requests carry authenticated queries and writes to the workspace's
Durable Object. WebSocket subscriptions receive committed changes and share
the connection with presence. The Durable Object writes to SQLite and the
transaction log; its durability alarm ships log segments and snapshots to R2.
