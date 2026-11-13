# TapeDB — scope contract

The equivalent of InstantDB's developer surface, built only from Cloudflare
primitives, shipped as a library that provisions itself into the consumer's own
account.

**Definition.** TapeDB is a log-structured database for Cloudflare Durable
Objects. One SQLite database per workspace lives inside a single Durable
Object, every transaction is appended to a log, the log is shipped to R2 and
replayed on cold start, and clients subscribe to live queries over one
WebSocket with an optimistic cache and a durable outbox.

**Lineage.** The developer surface is inspired by InstantDB and keeps its
ergonomics: InstaQL-shaped queries in the shape of the data you want,
InstaML-shaped transactions (`db.tx.<ns>[id].update/link`), multiplayer
queries, presence, and `db.storage` for files. The implementation shares no code
with InstantDB and depends on none of its packages.

## Parity map

Status is measured against InstantDB's published docs surface.

| InstantDB surface | TapeDB | Status |
| --- | --- | --- |
| `modeling-data` — namespaces, links, attributes | `engine/registry.ts` + workspace migrations | HAVE |
| `instaql` — relational queries in result shape | `query-compile.ts`, `query-execute.ts`; `where`, `order`, `limit`, nested link traversal | HAVE |
| `instaml` — transactions | `tx-pipeline.ts`; update, merge, delete, link, unlink; idempotent by `clientTxId` + `opsHash` | HAVE |
| multiplayer live queries by default | `subscriptions.ts`; namespace touch, 50 ms batching, entity diffs | HAVE |
| offline cache and optimistic updates | `query-cache.ts` + `outbox.ts`; IndexedDB outbox keyed by `clientTxId` | HAVE |
| `presence-and-topics` — presence, cursors | `presence:set/clear`, `cursor:set`, `drag:set/clear` on the workspace socket | HAVE presence, no topics abstraction |
| `storage` — file uploads | `/storage/:appId/:objectKey`, `FILES` bucket, 25 MB cap, MEMBER read / EDITOR write | HAVE |
| `infinite-queries` — cursor pagination | keyset `after`, `pageInfo.nextCursor`, and `db.loadMore()` on the client | HAVE |
| `permissions` — row and attribute rules | role levels plus row rules over `{ auth, data, next, changed }` for view, create, update and delete | HAVE, with the scan cap noted below |
| `http-api` — server-side access | `POST /query`, `POST /transact`, `GET /status` | HAVE |
| `cli` — schema push | `tapedb init`, `dev`, `studio`; migrations are generated from the schema by `defineSchema` | HAVE |
| `self-hosting` | inherent, the consumer's account | HAVE by construction |
| `devtool` / `explorer-component` | kitchen-sink app, not shipped | OUT of v1 |
| `auth` — magic code, OAuth, guest | none; the engine consumes a trusted claim header | GAP by design, see below |
| `backups` — user-facing export | the log and snapshots are internal durability, not an export API | OUT of v1 |
| `streams` | none | OUT |
| `teams`, `users`, `emails`, `stripe-payments`, `webhooks`, `platform-api` | none | OUT, these belong to the host app |

## Infrastructure footprint

Exactly three resources. `tapedb init` creates all of them, unconditionally,
because there are no capabilities to choose between.

| resource | purpose |
| --- | --- |
| 1 Durable Object class | the workspace database, which also carries presence on its socket |
| R2 bucket `DATA` | transaction log segments and snapshots |
| R2 bucket `FILES` | image and file uploads |

No D1. Memberships and sessions belong to the consumer's identity system, and
the engine never reads them. It reads one header.

## Package layout

One package, one install. Subpaths exist to keep React out of the server
bundle, not to make features optional.

```
tapedb            client, schema, query and tx types, zero runtime deps
tapedb/react      hooks; React is a peer dependency
tapedb/worker     the Worker entry and the Durable Object class, ready to export
tapedb/cli        init, migrate, dev, deploy
```

Consumer surface, all of it:

```ts
import { init, i, id } from "tapedb";

const db = init({ workspaceId, schema, getToken });

db.useQuery({ boards: { $: { where: { id } }, columns: { tasks: {} } } });
await db.transact([db.tx.tasks[t].update({ done: true })]);
await db.storage.upload(file);
db.usePresence({ cursor, typing: true });
```

## Non-negotiables

1. **Out of the box.** One install, one command, three resources. No capability
   flags, no optional packages, no hand-wired routes. The library ships its own
   Worker entry.
2. **The core has zero runtime dependencies.** No React, no Radix, no dnd-kit,
   no xyflow, no dagre, no lucide in `tapedb`. React appears only in
   `tapedb/react`.
3. **One Durable Object class.** Presence rides the database socket. A second
   class is a second deploy-order commitment the consumer pays for.
4. **No UI ships.** No kanban, whiteboard, diagram, canvas, theme or i18n.
5. **The write path is HTTP, the read path is the socket.** Transactions post to
   `/transact`; the socket carries subscriptions, presence, cursors and drag.
   Documentation must say this, never "realtime transactions over WebSocket".

## Out of scope, permanently

ndex product surface that must never enter this repo: kanban, whiteboard,
diagram, canvas, theme, i18n, the Yjs document room, the per-app realtime room,
the app registry, and the `/apps/:appId/*` routes.

## Three decisions

**1. Auth is a seam, not a feature.** DONE. The engine consumes a verified claim
and never issues one. `defineTapeDB({ identity })` takes two methods,
`getSubject(headers)` and `getRole(workspaceId, sub)`, and the library serves
`POST /_tapedb/claim` for any identity provider. BetterAuth is the reference
integration, not a dependency. `devClaims` mints an OWNER claim in development
and is refused whenever `ENVIRONMENT` is `production`. Owning passwords would
make this a BaaS.

Development loop, verified end to end under `wrangler dev`: `tapedb init` then
`tapedb dev` gives a local database with a working claim route, so the client
runs with no session and no configuration.

**2. Permissions stay role-level in v1, designed to grow.** InstantDB evaluates
CEL rules per row and per attribute. TapeDB gates by role level per namespace
and action. That is coarser and it is already built and tested. The claim
already carries `sub` and `role`, so row-level rules can land later without a
wire change. Do not promise attribute-level rules in v1.

**3. Cursor pagination is in v1.** `pageInfo` is already reserved in the query
response and `limit`/`order` already compile. Infinite queries are a
first-class InstantDB feature and the gap is small.

## Extraction tasks implied by this contract

DONE:

- Permissions overrides and the namespace registry are consumer configuration.
- Every `ndex-*` literal is gone: header, bucket, error codes, IndexedDB name.
- `defineSchema()` emits the registry, the migrations and the client schema from
  one object.
- `dist` builds, `.d.ts` per subpath, real `exports`, `files`,
  `sideEffects: false`, LICENSE.
- `tapedb init` and `tapedb dev` replace the monorepo scripts.
- Recovery restore order, self-referential tables and the allowed-table set are
  derived from the registry instead of hardcoded ndex tables.

DONE since first draft:

- The upstream engine suite runs again (13 files, 166 tests total) against an
  ndex-shaped fixture that configures the registry, permissions and migration
  bundle before each file.
- Uploads write a `$files` metadata row into the workspace and expose
  `GET /files`; delete removes it. Bytes stay in R2 and never enter the log.
- Cursor pagination: `after` compiles to a lexicographic WHERE clause, and
  `pageInfo.nextCursor` is emitted when a page has more rows.
- Headless `init` in `tapedb`; the React entry wraps the same instance.
- Dev claims require the code flag and `TAPEDB_DEV_CLAIMS=true`, which
  `tapedb dev` passes and `wrangler deploy` never does.

DONE: row rules for create, update and delete (`write` decisions can be a
predicate over `{ auth, data, next }`), evaluated inside the transaction so a
replay is not re-judged and a throwing rule denies. `view` stays level-only by
design; `defineSchema` refuses a view rule rather than shipping a no-op.

DONE: row-level **view** rules filter rows (and nested children) after fetch;
`changed` gives rules the attribute names an op writes, so one field can be
gated; `tapedb studio` is a local table browser over `/schema`, `/query` and
`/transact`, and `GET /engine/workspaces/:id/schema` exposes the registry for
tooling.

REMAINING:

- View rules still cannot use an index. Pages are filled by scanning up to
  `max(limit * 10, 200)` rows, so a rule that hides almost everything costs a
  bounded scan per page and can return a short page at the cap.
- `clientTxId` idempotency survives a cold start only for transactions still
  held in retained log segments. A snapshot does not carry idempotency keys, so
  once a transaction is folded into a snapshot a retry is re-applied. Measured
  live: the segment-backed retry returned `applied: 0, seq 3`; the
  snapshot-backed retry was re-applied. Carrying keys in the snapshot is the
  fix, and it is a format change.
- `db.loadMore()` resets to page one on reconnect: the live subscription
  re-subscribes the original query. Deep pagination over a long session is
  therefore cursor-based per request, not accumulated client-side forever.
- `$files` rows are written outside the transaction log, so they are not part of
  the replay; a crash between the R2 put and the row write leaves an unlisted
  object, which the 502 makes visible rather than silent.
