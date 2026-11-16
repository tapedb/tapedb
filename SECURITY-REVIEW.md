# Pre-release security review — 2026-11-15

Scope: TapeDB main at `691aafa15bfd3fdbdcf74cf32b1060ebd5f4ffd8`, plus
this release-validation change. This is a source and regression-test review
by the implementing assistant, not an independent audit or penetration test.

## Boundaries checked

| Boundary | Source reviewed | Evidence |
| --- | --- | --- |
| Claim verification | `src/verify.ts`, `src/mint.ts`, `src/claim-route.ts` | HS256 algorithm allowlist, signature verification before payload trust, expiry and workspace checks, configured issuer/audience checks; `test/claims.test.ts` covers tampering, expiry, wrong workspace and development-claim production refusal. |
| Worker-to-room trust | `src/worker/index.ts`, `src/engine/trusted-claim.ts` | Authentication precedes workspace addressing; the Worker replaces `x-tapedb-claims` with verified identity. New `test/worker-boundary.test.ts` checks header forgery across engine routes, role replacement and cross-workspace refusal before a room is touched. |
| Rows and relations | `src/engine/tx-permissions.ts`, `src/engine/tx-pipeline.ts`, `src/engine/query-execute.ts`, `src/engine/export.ts` | Read filters/checks apply to queries and exports; write checks run with the transaction. Existing permission, relation-filter and export tests cover fail-closed rules and hidden rows. |
| File bytes and index | `src/worker/index.ts`, `src/engine/file-access.ts`, room file routes | Workspace-prefixed R2 keys, rules before access, index routes restricted to internal writes, bounded upload requests, versioned byte objects and cleanup after index failure. Multipart upload identifiers act as capabilities for parts/abort; start and completion recheck authorization. Existing worker-file/file-rule tests cover failure cleanup, executable content policy and denial rules. |
| Workspace erasure | `src/engine/workspace-room.ts`, `src/engine/r2-list.ts` | Owner-only deletion removes history, indexed and orphan byte versions, subject keys and local storage; a tombstone rejects late clients. Existing workspace-room tests exercise non-owner refusal and retry after an R2 error; the packed recovery drill checks an erased workspace cannot recover old data from R2. |
| Personal fields | `src/engine/personal.ts`, `src/engine/personal-write.ts`, personal route and export | AES-GCM authenticates context; wrapped subject keys live outside SQL history. Owner key deletion clears plaintext caches and live query results. Receipt hashes use HMAC for personal values. Existing personal-field tests cover ciphertext in history, key erasure, recovery and forbidden aggregates. Earlier targeted findings and fixes are recorded in PR #82. |
| Moves/imports | `src/engine/workspace-move.ts`, `src/engine/import-workspace.ts`, room controls | Owner-only public operations, internal move routes unavailable publicly, empty destination requirement and source write freeze. Existing move/import/recovery tests cover interrupted work and retry receipts. |
| Offline persistence | `src/client/outbox.ts`, write submission/retry in `src/client/data-client.ts` | Found and fixed acknowledgment before IndexedDB transaction completion, and fallback entries disappearing when persistent storage became readable. The old implementation fails two new unit regressions; the fixed implementation passes. Chromium covers reload and replay separately. |

## Validation record

- Frozen dependency installation and `bun run verify` run on the changed source.
- Package smoke emits declarations from the installed tarball for default npm,
  CommonJS and ESM projects. It exposed private-name declaration failures,
  fixed with named public types and a type-only room export.
- `bun scripts/soak.ts --generations 24 --ops 3000`: passed 24 repeated
  snapshot/log recovery generations, ending at 43,001 rows and sequence 48,279.
  This uses Bun SQLite and fake R2. It is a durability stress test, not
  production dogfooding.
- CI additionally runs the packed workerd consumer/recovery suite and real
  Chromium persistence tests. Their run outcomes must be checked on the PR
  before merging; merely adding the jobs is not a pass.

No additional exploitable claim, workspace, file or erasure bypass was found
in this scoped review. That statement is limited to the paths and tests above.

## Operator requirements and remaining evidence

Keep signing/wrapping secrets server-side; keep the wrapping secret stable.
The identity adapter must resolve real sessions and memberships. Configure
CSRF protection appropriate to its session mechanism. Disable development
claims in production and keep claim-bearing headers out of logs. Claim limits
fail open on limiter unavailability and log that event, as SECURITY.md states.

Personal key deletion does not erase prior plaintext from pre-encryption
history or external exports. Those copies require their own retention and
erasure process. Cloudflare's point-in-time recovery caveat remains.

The subsequent independent source review and remediation are recorded in
[INDEPENDENT-REVIEW.md](INDEPENDENT-REVIEW.md). Validate the exact release
candidate against the checks in [RELEASING.md](RELEASING.md).
