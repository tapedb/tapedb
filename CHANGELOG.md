# Changelog

## 0.1.0 - Unreleased

TapeDB is still a private preview. No npm package or public repository has been
published.

### Added

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
- **Breaking:** the `tapedb/cli` subpath export is gone; run the CLI with
  `npx tapedb`. `tapedb` no longer exports the Worker `Env` type (import it
  from `tapedb/worker`). `tapedb/worker` no longer exports `WorkspaceRoom`
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
