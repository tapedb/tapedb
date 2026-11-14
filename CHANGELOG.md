# Changelog

## 0.1.0 - Unreleased

TapeDB is still a private preview. No npm package or public repository has been
published.

### Added

- Real CI for the frozen install, typecheck, tests, build, package smoke and a
  full-history secret scan on Node 22.18 or newer.
- Security policy, code of conduct, issue and pull-request templates, and
  dependency update configuration.
- Release gates and a documented list of product limitations.
- `homepage`, `packageManager` and provenance publishing metadata.

### Fixed

- The durability pass flushed one ~1 MB log segment per alarm, every 30
  seconds, so a workspace writing faster than that fell further behind R2
  with every write and could lose its newest writes in a wipe. A pass now
  drains the backlog (up to 20 seconds), and a failed flush is logged as
  `workspace_flush_failed` instead of being retried silently.
- The scratch table that staged queries use is recreated after an erase or a
  recovery reset, which drop every table while the room keeps running.

### Changed

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
