# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `view` rules can be `{ where: (auth) => filter }`. The filter is compiled
  into the SQL of every query level that reads the namespace, ANDed with the
  caller's own `where`, so it uses indexes and fills every page instead of
  scanning to a cap. An array of filters is OR. Unsupported operators are an
  error, a throwing rule hides every row, and a `where` rule on a write action
  is refused at `defineSchema` and `configurePermissions`.

### Fixed

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
