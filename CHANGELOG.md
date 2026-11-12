# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
