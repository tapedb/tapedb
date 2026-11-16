# Changelog

## 0.1.4 - 2026-11-16

- Interactive project setup installs TapeDB and Wrangler, offers local development or cloud deployment, and ignores local secrets.
- Deployment selects the Cloudflare account, reuses existing buckets and secrets, creates missing resources and uploads generated secrets with the Worker.


## 0.1.3 - 2026-11-16

### Fixed

- Loading a schema before installing the package resolves missing TapeDB
  imports through the CLI's own build without rewriting schema values.
  Package-name strings used as field defaults remain unchanged, and relative
  helper modules can resolve their own TapeDB imports too.

### Documentation

- `init` prints local installation, development and studio commands before
  the Cloudflare bucket and secret setup required for deployment.

## 0.1.2 - 2026-11-16

### Fixed

- `npx @tapedb/tapedb init` in a directory with no `node_modules` stopped before
  writing the first migration: the schema it writes imports the package by name,
  and that name cannot resolve from a project that has not installed it. `init`
  now retries the load against the CLI's own build, so the documented first
  command produces `tapedb/migrations/0002_entities.sql` as it says it does. The
  packed-consumer smoke covers the case by running `init` from outside the
  project, the way `npx` does.
- A schema that genuinely cannot resolve the package now says so, and names the
  install command, instead of reporting a schema error.

### Documentation

- The quickstart installs the library as well as scaffolding it: the Worker that
  `init` writes imports `@tapedb/tapedb/worker`, so the project needs it to build
  and deploy.

## 0.1.1 - 2026-11-16

### Documentation

- The `move` example gave `--url https://db.example.com`. `example.com` is
  reserved for documentation (RFC 2606), so that host never exists, and it is
  not the shape `tapedb init` produces: a deployed Worker answers on
  `https://tapedb-app.<account-subdomain>.workers.dev` unless a custom domain is
  attached. The example now uses that shape and says what `--url` refers to.
- The `client({ url })` comment pointed at `api.example.com`, in the shipped
  declarations and on the generated API pages.
- `verify` gains `test:docs`, which fails when a reserved example domain appears
  in a file the tarball ships.

## 0.1.0 - 2026-11-16

### Security

- The Worker refused `/move/*`, `/storage/*` and writes to `/files`, but a
  doubled slash in the request path (`/engine/workspaces/<id>//x/files`)
  reached them: the room URL was resolved relative to the path, so `//x/...`
  became a different URL. An editor could record an index entry pointing at
  any stored object and then read or delete it through the file routes; an
  owner could call the internal move controls. The room URL is now built from
  the path as is, a path with an empty segment outside `/files/` answers 404,
  the index accepts only objects stored under the file's own path, and every
  client `x-tapedb-*` header is removed before forwarding.
- `TAPEDB_CLAIM_SECRET` must be at least 32 bytes. A shorter secret could be
  recovered offline from any claim and used to forge others; signing and
  verifying now refuse it, and the claim routes answer 500
  `claim_secret_missing`. `tapedb init` already generates 32 random bytes.

### Changed

- Requests made while a workspace is being restored from R2 (503
  `workspace_recovering`) wait it out: the client retries reads, writes and
  file requests as `Retry-After` says, for up to a minute.
- A workspace whose move state R2 cannot read at boot (after three tries)
  answers 503 `workspace_recovering` and boots again on the next request,
  instead of resetting with an exception.
- The ops hash of each write (FNV-1a 64) is computed without a BigInt step
  per byte; digests are unchanged.
- Recovery reads each log entry stored in parts as its own unit and may
  stop before it, so a segment holding many large writes is no longer one
  long step.
- Recovery applies consecutive whole-row log entries (imports, and every
  write to a model with personal fields) under one foreign-key switch and
  one check, and none for entries the snapshot already holds. Before, each
  entry synced storage twice and checked every table. A whole-row entry in
  parts may stop between its parts like any other.
- Recovery applies a large log entry a part at a time, with its progress
  kept between steps, and new log entries store their ops in parts of
  256 KiB (was 1 MiB). A restore under way continues on alarms rather than in
  a later boot, and each step stops before a unit as slow as the slowest so
  far would overrun Cloudflare's 30 s of CPU.
- A restore from R2 keeps its progress when an R2 read fails and resumes
  5 seconds later. A restore that fails at boot leaves the workspace answering
  503 `workspace_recovering` while alarms retry, instead of an exception on
  every request.
- `$broadcast(topic).send()` and `useBroadcast`'s `send` return
  `boolean | "queued"`: a send while disconnected is queued, not dropped
  (experimental API).
- Offline retries have no age limit. Transaction receipt ids, sequences and
  times remain for the workspace lifetime; operation hashes are removed after
  half the history retention. Reusing an id with a different body conflicts
  while its hash exists and acknowledges the original write afterwards.
  Snapshots and recovery preserve receipts with removed hashes. Legacy
  upgrades and restores retain a fixed safety boundary for missing receipts.

### Added

- `tapedb migrate rollback [--to <id>]` writes the migration back to an
  earlier schema: renames undone with their values, additions removed with
  `--accept-data-loss`, drops refused. It lists the schema edits that make
  `migrate check` pass. The schema after each migration is kept in
  `tapedb/snapshots/<id>.json`.
- Reads over several workspaces: `db.$across(ids, { getToken })` with
  `findMany`, `findFirst`, `findPage` and `count`, merged in `orderBy` order,
  rows tagged with `workspaceId`, page cursors per workspace, live through
  `subscribe` and `useLive`, and `AcrossError` with the partial result when a
  workspace fails.
- Opt-in write audit: `defineTapeDB({ audit: true })` records each write's
  `sub` and role in the log and its R2 lines, restored by recovery, and a
  per-row history read with `db.$history({ model, id })` (admins and owners,
  `GET /engine/workspaces/:id/history`), pruned with the history retention.
  Engine migration `tapedb_0010_tx_audit`; error code `audit_disabled`.
- Broadcasts survive a dropped connection: sends made while the socket is
  down wait (100 per topic, 60 s) and go out after reconnecting, and the
  workspace keeps the last `topics.replaySeconds` (default 60, at most 1,000
  messages) of each topic, replayed in order to a listener that rejoins.
  Messages carry a per-topic `seq`; `topic:join { since }` answers
  `topic:joined { seq }`. Engine migration `tapedb_0009_topic_buffer`.
- Personal string and JSON fields with per-subject encryption, owner key
  erasure, nullable erased reads, live refresh and resumable encryption of
  existing rows. Queries and exports decrypt; durable history holds ciphertext.
- Quiet workspaces replace receipt-bearing snapshots after hash pruning, so
  old operation hashes leave R2 within retention without another user write.

- `tapedb move --to eu|fedramp|none`: resumable relocation of workspaces,
  durable history, receipt ids and indexed files. Sources freeze writes,
  destinations refuse existing data, and traffic switches before source
  cleanup. Optional discovery lists original R2 workspace prefixes.
- Owner-only NDJSON import into empty workspaces, staged and committed
  atomically with replayable logs, preserved timestamps and file metadata.
- File byte versions keep in-flight uploads from overwriting files during a
  move. Large copies use streamed R2 range bodies and multipart uploads.

- Built-in claim limits, on by default: `identity.limits` with exact, global
  token buckets per caller IP (300 per 60 s, before the session lookup) and per
  subject (30 per 60 s, after it), kept in limiter Durable Objects of the
  workspace class (no new binding). Buckets are keyed by HMACs, never the IP or
  subject. Past a limit: 429 `rate_limited` with `Retry-After`. `limits: false`
  turns them off; `allowRequest` still runs, after the IP limit.
- Per-file access rules: `schema(models, { files: { read, write, delete } })`
  with `role()`, `fileCheck()` over the caller and the file, or
  `attachedTo(model, path => id)` to make a file follow its row's rules. The
  workspace decides every file operation before bytes move and lists only
  readable files. The index records each file's uploader (`uploadedBy`,
  engine migration `tapedb_0006_file_uploader`).
- A workspace's status reports `durability`: its last sequence, how far the
  log has reached R2, the snapshot base and the last flush error.
- Real CI for the frozen install, typecheck, tests, build, package smoke and a
  full-history secret scan on Node 22.18 or newer.
- Security policy, code of conduct, issue and pull-request templates, and
  dependency update configuration.
- Release gates and a documented list of product limitations.
- `homepage`, `packageManager` and provenance publishing metadata.

### Fixed

- The IndexedDB outbox waits for the transaction to commit before acknowledging
  persistence. If a put succeeds but its transaction aborts, the entry remains
  in the fallback queue, including after IndexedDB becomes readable again.
  Removing or clearing entries also clears their fallback copies.
- Packed consumers can emit TypeScript declarations for the generated schema
  and Worker. Public type-only names (`ModelOptions`, `TapeDBSchema`,
  `BundledWorkspaceMigration`, `TapeDBRoom`) keep private names out of inferred
  consumer exports. The room has no new runtime export.
- `init` and the starter explain bucket creation and both deployment secrets;
  generated configurations enable logs and traces.

### Release validation

- CI runs the packed consumer's complete workerd scenarios and migration,
  workspace-erasure and R2-recovery drills on every pull request and main push.
- Chromium tests exercise an offline write across a full page reload,
  transaction replay, workspace isolation and abort-after-success persistence.
- Package smoke tests compile consumer declarations in default npm, CommonJS
  and ESM projects. IndexedDB abort and fallback regressions have unit coverage.

### Fixed

- Personal fields: `aggregate`/`groupBy` accepted them, returning ciphertext
  envelopes (with the subject's pseudonymous hash) as group keys and min/max;
  they are refused like filters and ordering. The decrypted-value cache had no
  bound and could exhaust a Durable Object's memory; it is now capped (8 M
  UTF-16 units, least recently used out), and a read larger than the cap still
  completes. Receipt and log hashes of transactions carrying personal values
  were a plain hash of the plaintext, guessable for short values after the
  subject's erasure; they are an HMAC under `TAPEDB_KEY_SECRET`.
- A workspace whose restore from R2 took longer than 30 seconds could never
  recover, and could be served half restored: recovery ran inside the Durable
  Object's boot, which Cloudflare resets after 30 seconds, and the reset left
  restored rows that the next boot took for a populated workspace (rows
  present, sequence 0). Recovery now commits its progress per snapshot chunk
  and log segment, spends at most 15 seconds per boot, continues on alarms,
  and resumes a run that was cut off. Until it is complete the workspace
  answers 503 `workspace_recovering`. This was the intermittent export failure
  in the staging drill after the class wipe.
- A socket's live queries, presence and topics lived in its attachment,
  which Cloudflare caps at 16 KiB: past that (a few dozen ordinary live
  queries on one client, or one large one) every subscribe failed. They now
  move to the workspace's storage when they outgrow it.
- Socket messages above 64 KiB were refused. There is no TapeDB bound now:
  the client sends large messages in parts the workspace joins, and topic
  messages in parts the workspace relays as they come, so a broadcast of any
  size reaches its listeners.
- `executeQuery` compiled the caller's read rules but ran the query without
  them, so a `filter()` or `check()` read rule did not hide rows. No route
  used it (routes use `executeQueryWithPageInfo`, which was correct); it now
  applies the rules.
- A transaction log entry over 10 MB could never reach R2: its multipart
  upload cut parts at line ends, so they differed in size, and R2 refuses
  that. Parts are now cut at exactly 5 MiB of encoded bytes.
- The durability pass flushed one ~1 MB log segment per alarm, every 30
  seconds, so a workspace writing faster than that fell further behind R2
  with every write and could lose its newest writes in a wipe. A pass now
  drains the backlog (up to 20 seconds), and a failed flush is logged as
  `workspace_flush_failed` instead of being retried silently.
- The scratch table that staged queries use is recreated after an erase or a
  recovery reset, which drop every table while the room keeps running.

### Changed

- Files of any size upload. `$files.upload` sends files past 16 MiB as an R2
  multipart upload in 16 MiB parts, through new `?uploads` / `?uploadId=`
  forms of the file route, and abandons the upload if a part fails. One
  request still carries at most 25 MiB (`MAX_UPLOAD_BYTES`). Oversized
  requests now answer `upload_too_large` instead of `file_too_large`, and
  the client's `MAX_STORAGE_UPLOAD_BYTES` is replaced by `UPLOAD_PART_BYTES`.

- `updateMany` and `deleteMany` are queued offline and applied optimistically,
  like single-row writes: the cache changes the rows it holds that certainly
  match (a three-valued local evaluation of the filter, checked against the
  engine on random rows and filters), and the engine settles the rest. While
  queued the result is `{ count, queued: true }`.
- **Breaking:** `updateMany` and `deleteMany` write every matching row in one
  transaction, however many match: they commit whole or not at all. Before,
  past 1000 rows they committed in separate 1000-row transactions and a
  failure left the earlier batches written. `BulkWriteError` is gone; a failed
  bulk write rejects like any write. The filter is resolved once, before the
  write; rows are checked, applied and logged a chunk at a time, and the log
  stores them compactly (ids and values once), in parts when an entry is
  larger than a Durable Object row holds, flushed to R2 as their own object.
- Any transaction, not only a bulk write, can be larger than one Durable
  Object row: its log entry is stored in parts.
- A model whose read rule is a function can be the target of a relation
  filter: the linked rows are read, the rule applied, and only the rows it
  shows count. Before, such a filter was refused.
- `select` and `include` combine at one level: the selected fields plus the
  included relations.
- Relation filters and nested creates are typed at every depth, not one
  level; a wrong field four hops down is a type error. `bun run typecheck`
  now also compiles type tests in `test/types`.
- Relation filters nest without limit and filters can be any length. A Durable
  Object's SQLite refuses expressions deeper than 100 and very long statements,
  which capped relation filters at about eight hops and failed `OR`s of a few
  thousand branches; past a few hops, or past that length, the engine now runs
  part of the filter first into a scratch table and tests membership in it.
- The public API is frozen and documented in `API.md`: every export is stable,
  experimental (`aggregate`, `groupBy`, `$broadcast`, `useBroadcast` and the
  `topics` option) or internal. `test/api-surface.test.ts` checks exports,
  signatures, the CLI usage and the error codes against `api/surface.json`.
- **Breaking:** the `@tapedb/tapedb/cli` subpath export is gone; run the CLI with
  `npx @tapedb/tapedb`. `@tapedb/tapedb` no longer exports the Worker `Env` type (import it
  from `@tapedb/tapedb/worker`). `@tapedb/tapedb/worker` no longer exports `WorkspaceRoom`
  (use `defineTapeDB(...).WorkspaceRoom`, as `tapedb init` writes),
  `authenticateEngineRequest`, `encodeTrustedRoleClaim`, `extractClaimToken`,
  `TRUSTED_CLAIM_HEADER`, `mintClaim`, `mintDevClaim` or
  `MintClaimDependencies`; mint claims with `signRoleClaim`.
- Removed the unused `SERVICE_VERSION`, `ENABLE_SMOKE` and `ALLOWED_ORIGINS`
  settings and the never-produced `duplicate_tx` error code.

- File uploads now read the request stream with a hard 25 MB limit instead of
  buffering an unbounded body before checking its size.
- The package version is `0.1.0` for the private preview. The package remains
  `private` and unpublished until the release gates are satisfied.

### Security

- The public claim route can be rate-limited: `ClaimIdentity` takes an
  optional `allowRequest(key)`, checked before the session lookup. SECURITY.md
  already recommended this, but `defineTapeDB` never passed a limit to the
  route, and since the freeze no exported function could set one. The API
  snapshot now scans all of `src` for error codes; it had missed the claim
  route's `rate_limited`, `rate_limit_unavailable`, `not_a_member`,
  `session_lookup_failed` and `membership_lookup_failed`.
- The workspace file index now checks roles: clients can list it with MEMBER
  or higher and can no longer write it directly; the room checks the claim
  itself as well. Before, any claim holder could list, add or remove index
  entries. (#65)
- Serve uploaded bytes with `X-Content-Type-Options: nosniff` and a sandboxing
  Content-Security-Policy, so a user-controlled HTML or SVG content type cannot
  execute script from the application origin.
- Documented the claim, workspace, file and erasure model, including operator
  responsibilities and the Cloudflare point-in-time recovery caveat.
