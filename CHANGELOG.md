# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `upsert` transaction op with separate `values` and `create`: the engine
  creates the row from `create` when it is missing and writes `values` when it
  exists, deciding inside the transaction. Row rules judge whichever set will
  be written. The optimistic cache makes the same choice from what it holds.

- Query filters gain `$nin` and the logical keys `$or`, `$and` (non-empty
  arrays of filters) and `$not`, nesting up to four levels. Null handling
  matches `$ne`: a row whose field is null is "not in" a list and matches the
  negation of a filter on that field.
- `$: { count: true }` reports the total matching rows, ignoring `after` and
  `limit`, as `pageInfo[ns].count`; with `limit: 0` no rows are read. Counts
  honour `{ where }` view rules and are refused on a namespace whose view rule
  is a function, since that rule runs after fetch and the count would include
  hidden rows. Counts stay live through the page-metadata path.

- `insert` and `patch` transaction ops, the strict halves of `update`'s
  upsert: `insert` fails with `unique_violation` when the id exists and is
  gated by the `create` decision; `patch` fails with `not_found` when the row
  is missing. Both are logged and replayed like any op. They are the engine
  side of the model API's `create` and `update`.

- `view` rules can be `{ where: (auth) => filter }`. The filter is compiled
  into the SQL of every query level that reads the namespace, ANDed with the
  caller's own `where`, so it uses indexes and fills every page instead of
  scanning to a cap. An array of filters is OR. Unsupported operators are an
  error, a throwing rule hides every row, and a `where` rule on a write action
  is refused at `defineSchema` and `configurePermissions`.

- Retries are refused rather than re-applied when the engine cannot vouch for
  them. The client records `basisSeq` (the highest sequence it had observed)
  and an attempt count on each outbox entry, and sends `basisSeq` on every
  send after the first. Recovery records `dedupe_floor_seq`, the highest
  sequence whose key a pruned segment took with it; a retry whose basis sits
  below that floor and whose key is unknown gets `dedupe_expired` (409). The
  client drops it and calls the new `onWriteRejected` config callback, which
  also fires for any other permanent refusal during a background flush.

### Fixed

- Live queries keep their page metadata. The client rebuilt its state on every
  `query:diff` without `pageInfo`, so after one live change `loadMore()`
  returned false and paging stopped. The engine also never re-sent `pageInfo`
  after the first result, so `hasMore` and `nextCursor` went stale when rows
  landed past the window. Diffs now carry `pageInfo` when it changes (an empty
  diff if no row in the window moved), and the client keeps the previous value
  otherwise.

- `db.loadMore()` no longer resets to page one on reconnect. After each page
  the client widens the live subscription's `limit` to the rows it has loaded
  (clamped to 1000, the engine's ceiling), so the reconnect re-subscribes the
  whole window, and the engine diffs rows on later pages like the first.

- `$files` rows are written through the transaction log as engine-only
  `file:put` / `file:forget` entries and replayed on recovery. They were written
  in place before, so only snapshots carried them: a restore from R2 lost every
  upload since the last snapshot and brought back every file deleted since.
  Clients cannot submit these ops; `/transact` refuses them. Segments written
  by this version contain file entries that older builds cannot replay.

- Recovery rebuilds `_tx_log` from the replayed log segments instead of
  discarding it, so a `clientTxId` retry that crosses a cold start returns
  `applied: 0` rather than applying twice. Segment lines already carried the
  idempotency key and attribution; the recovery parser was dropping them, and
  `ops_hash` is recomputed canonically rather than stored.
- Covered log segments are retained for `DEDUPE_HORIZON_SEQ` (2000 sequence
  numbers) past the snapshot base instead of being pruned the moment a snapshot
  lands. A snapshot stores rows, not idempotency keys, so the segment was the
  only remaining copy of the key for a retry that crosses the snapshot; pruning
  it immediately is what made the retry re-apply. Measured live on a fresh
  workspace whose first snapshot folded both transactions: the retry now returns
  `applied: 0`.

## [0.0.1]

First extract. The engine and client were lifted out of a production application
and de-branded; the API surface has not stabilised, so treat `0.0.x` as a
preview.

### Added

- Log-structured engine: one Durable Object per workspace owning a SQLite
  database, with an append-only `_tx_log`, sequence allocation, idempotent
  transactions keyed by `clientTxId`, and R2 durability (NDJSON log segments
  plus chunked snapshots) with an idempotent cold-start replay.
- Relational queries in the shape of the result (`where`, `order`, `limit`,
  nested link traversal) compiled to SQL.
- Live queries: per-subscription invalidation by touched namespace, 50 ms
  batching, entity-level diffs, presence on the same socket.
- Optimistic writes with an IndexedDB outbox keyed by `clientTxId`, replayed on
  reconnect.
- Keyset cursor pagination (`$: { after }`, `pageInfo[ns].nextCursor`), so an
  insert above the window cannot repeat a row.
- Permissions: role levels per namespace per action, plus row rules over
  `{ auth, data, next, changed }` for create, update, delete and view. Rules run
  inside the transaction; a throwing rule denies.
- `defineSchema()` as one source for the engine registry, the SQL migrations and
  the client schema.
- Claim adapter: `defineTapeDB({ identity })` serves `POST /_tapedb/claim` for
  any identity provider; `devClaims` mints an OWNER claim in development and is
  refused when `ENVIRONMENT` is `production`.
- File uploads to R2 with a `$files` metadata index inside the workspace.
- `GET /engine/workspaces/:id/schema` for tooling.
- CLI: `tapedb init`, `tapedb dev`, `tapedb studio`.
- Four entry points: `tapedb` (React-free, zero runtime deps), `tapedb/react`,
  `tapedb/worker`, `tapedb/cli`.

### Notes

- `view` rules filter after the SQL page, so a heavily filtered namespace reads
  more rows than it returns.
- `tapedb init` writes `ENVIRONMENT: "development"`; a deployment must set
  `ENVIRONMENT` to `production` and never set `TAPEDB_DEV_CLAIMS`.
