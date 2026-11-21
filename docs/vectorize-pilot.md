# Vectorize pilot record (CLOUD-01)

What the vector search integration was proved to do on a real Cloudflare account
and a real Vectorize index, what it was not, and where each acceptance criterion
stands. Measured on 2026-11-20 with `@tapedb/tapedb` 0.3.3, wrangler 4.166 and
npm 12.2.3, before the packages were published.

This file is the release evidence the integration's acceptance criteria ask for.
It is repository material, not part of the npm package (the tarball ships
`README.md`, `API.md` and the policy files, not `docs/`).

## Environment and fixture

- One deployment, `tapedb-vector-pilot`, on workers.dev, production mode, one
  workspace (`0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a71`).
- One index, `tapedb-tapedb-vector-pilot-note`, 768 dimensions, cosine, one
  metadata index (`archived`, boolean). Created by `tapedb deploy`, not by hand.
- Schema: `note { title, excerpt, archived: boolean = false, embedding:
  t.vector({ dimensions: 768 }).optional() }`.
- Three rows: two unarchived, one archived. Embeddings were deterministic
  app-supplied vectors (one hot dimension per word), so a query's expected
  ranking is known without a model.
- The host was torn down at the end. The numbers below are the record; there is
  no standing pilot deployment.

## Measurements

| observation | measured |
| --- | --- |
| fresh deploy provisions the index, metadata index, binding and record | index created 2026-11-20T22:34:36Z; binding table shows `env.VECTORIZE (tapedb-tapedb-vector-pilot-note)` |
| repeat deploy converges | `Vectorize: kept tapedb-tapedb-vector-pilot-note`, zero create calls |
| deploy after the checkout (and the record) was lost | ownership record reconstructed by hand, next deploy converged on the same index |
| tampered ownership record (wrong account) | `Refusing to deploy: … account tampered-account vs b2b8cf69… Nothing was deployed.` |
| write committed to queue acceptance | 7.2 s for three rows |
| write to searchable | 69.3 s |
| update (new embedding) to searchable | 52.4 s |
| filter `archived: false` / `archived: true` | 2 rows / 1 row, the archived note only in the second |
| per-row status | 3 × `indexed`; a missing id was omitted from the answer |
| rebuild started by two concurrent requests | one `jobId`, `enqueued: 3`, second answer `started: false` |
| search while the rebuild ran | `503 vector_search_unavailable`, `retry-after: 30` |
| search after the rebuild completed | 200, 3.4 s after the job left the queue |
| member (editor) calling rebuild or retry | `403 insufficient_role` |
| retry with nothing failing | `200 { requeued: 0, pending: 0, failing: 0, deadLettered: 0, indexed: 3 }` |
| query vector of the wrong shape | `400 invalid_value` |
| workspace erase to an empty index | erase 200 (`historyObjects: 4`), workspace `410 workspace_erased`, index still held 3 vectors at +60 s and none at +75 s |

One observation worth recording as behaviour rather than a defect: a filtered
search issued seconds after the vectors became visible returned nothing while
the unfiltered search of the same moment returned all three rows, and the same
filtered query was correct seconds later. The provider's own query tool
(`wrangler vectorize query --filter`) agreed with the later answer, so this is
metadata-index visibility lag, not a filter bug. A client must not treat an
empty filtered answer immediately after indexing as proof that nothing matches.

## Acceptance criteria

Test names are the `bun test` names in `test/vector-*.test.ts` and
`test/cli-vectorize.test.ts`; "pilot" rows are the measurements above.

| ID | state | evidence |
| --- | --- | --- |
| DEP-01 | covered | `no table, no binding, no call`; deployment without the option creates nothing |
| DEP-02 | covered | pilot: fresh deploy, index + metadata index + binding + smoke query |
| DEP-03 | covered | `a deploy that loses the creation race converges instead of failing`; pilot: repeat deploy and record reconstruction |
| DEP-04 | covered | `an index of the wrong dimension count`, `an index with another metric`, `a metadata index of the wrong type`, `an index this deployment cannot prove it created`, `an ownership record that no longer matches the deployment`; pilot: tampered record refused before upload |
| DEP-05 | covered | `a residency-restricted deployment, before any Vectorize call` (unit; no live `eu` deployment) |
| DEP-06 | **not covered** | an existing workspace upgraded over pre-vector history was not exercised on a real deployment |
| VAL-01 | covered | `an all-zero vector is refused`, `a value that overflows float32 is refused`, `a length that is not the declared one is refused`, `a rejected embedding in an update leaves the stored one in place`; pilot: wrong shape `400 invalid_value` |
| VAL-02 | covered | `an attribute the deployment did not declare is refused, not ignored`, `50 is the ceiling: it is answered, and 51 is refused rather than clamped`, `a model this deployment does not index is refused` |
| WRI-01 | partly | `a commit succeeds with the index failing, and the queue keeps the intent` (in-memory outage, not a live one) |
| WRI-02 | covered | `the queue survives the object that wrote it`, `a failed drain retries with backoff and loses nothing` |
| WRI-03 | covered | `a changed filter value alone re-publishes, because a metadata filter would otherwise go stale`, `a row whose vector changed since it was published is ranked on nothing`; pilot: update lag |
| WRI-04 | partly | `a row is published once, with its vector and its filters` covers coalescing; bulk, nested and cascading writes were not measured separately |
| WRI-05 | partly | `an erasure interrupted before the index answered resumes from the ledger alone` covers recovery; a late older write was not injected |
| WRI-06 | partly | `a failed drain retries with backoff and loses nothing`; live rate limiting and quota denial were not forced |
| SRC-01 | covered | `rows come back nearest first, with the score each was found by`; pilot: known vectors ranked as expected |
| SRC-02 | partly | index and namespace are derived (`vectorIdFor`, `vectorNamespaceFor`, unit); two workspaces with the same row id were not run live |
| SRC-03 | covered | `a caller does not receive a row their read rules exclude`; pilot: a missing id is absent rather than reported |
| SRC-04 | covered by design | every candidate is re-read through the read path, so a rule change applies without reindexing (unit: read-path tests) |
| SRC-05 | partly | the version gate drops rows whose stored state moved (`a row whose vector changed since it was published is ranked on nothing`); a provider returning a stale filter value was not injected |
| SRC-06 | covered | `a refusal reaches the caller as the engine's code and message`; pilot: 503 during rebuild, 400 for a bad vector |
| SRC-07 | covered | `sends one search request and puts each row's score on the row` |
| REC-01 | partly | `the purge finishes after the workspace's own storage is destroyed`; rebuild cursor resumption is unit-tested, but not across a real eviction |
| REC-02 | **not covered** | full provider inventory for obsolete IDs remains out of scope, as stated in `API.md` |
| DEL-01 | covered | `deleting a row enqueues a delete of its vector`, `an erase whose fence cannot be written deletes nothing`; pilot: erase emptied the index |
| DEL-02 | covered | `erasing a workspace deletes every ID it could have written, including a gone row`, `verification matches the delete's own mutation, never a watermark that moved`, `the purge finishes after the workspace's own storage is destroyed`; pilot: 60–75 s to zero vectors |
| OBS-01 | partly | pilot: `pending`, `failing`, `deadLettered`, `indexed`, `fenced`, `rebuild` all read live; log-content assertions are unit-level |
| OPS-01 | covered | pilot: member `403`, two concurrent rebuilds get one `jobId`; unit: `an ordinary member cannot retry or rebuild`, `two concurrent requests converge on one job` |
| CLOUD-01 | covered | this document |

## Not covered, and why

- **DEP-06** needs a workspace that existed before the vector field, restored
  from pre-vector history. The pilot started fresh; the migration path is
  covered by the schema/migration tests and by `unindexed` being the state of a
  row without an embedding, but not on a real deployment.
- **workerd e2e for the provider protocol.** `scripts/e2e/` has no Vectorize
  emulation, and the Workers binding cannot be intercepted in workerd, so the
  in-process double remains the protocol stand-in. `CONTRIBUTING.md`'s rule that
  a protocol feature is not covered until `scripts/e2e/` exercises it is
  therefore still unmet for this feature; the pilot above is what stands in for
  it.
- **REC-02** provider inventory: the engine knows the IDs it published; it does
  not enumerate the index. `API.md` states this limit.
- **Two-workspace isolation on a live index** (SRC-02) and a **late older
  write** (WRI-05) were not run; both are unit-covered, neither is measured
  against the provider.

## Reproducing the pilot

Four files and two commands, run from the checkout whose `dist/` is built:

```bash
mkdir -p /tmp/tapedb-vector-pilot && cd /tmp/tapedb-vector-pilot
# package.json: @tapedb/tapedb as "file:/abs/path/to/tapedb", wrangler ^4.166
npm install
node /abs/path/to/tapedb/dist/cli.js migrate dev --name init
node /abs/path/to/tapedb/dist/cli.js deploy --yes
```

`tapedb.vectorize.json` holds `{ model, field, filterFields }`; `wrangler.jsonc`
holds the `vectorize` binding the CLI writes. After the deploy, a claim signed
with `TAPEDB_CLAIM_SECRET` is enough to drive `/engine/workspaces/:id/transact`,
`/search`, `/vector/rebuild` and `/vector/rows`; no identity adapter is needed.

Teardown is four resources: `wrangler delete --name <worker> --force`,
`wrangler vectorize delete <index> --force`, the two R2 buckets (the data bucket
still holds the purge ledger under `vector-purge/<deployment>/<workspace>/` and
refuses to delete until those objects are removed).

## Defects this pilot found

1. Wrangler warned `Unexpected fields found in top-level field: "tapedb"` on
   every command, because the declaration lived inside `wrangler.jsonc`. It
   moved to `tapedb.vectorize.json`.
2. `vectorize list-metadata-indexes` does not exist; the command is singular and
   answers `{ propertyName, indexType }` with `Bool`/`Str`/`Num`. Wrangler
   prints help and exits 0 for the wrong name, so the previous code validated
   against nothing on a repeat deploy.
3. A failed `create-metadata-index` was ignored. It now throws with the
   provider's output.
4. npm 12 changed `npm pack --json` from an array to an object keyed by package
   name, which broke `test:package` and `test:e2e` on the upgrade.
