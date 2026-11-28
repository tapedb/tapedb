# Changelog

## 0.5.2 - 2026-11-28

- Extensions are stable: `schema(models, { extensions })`, `defineTapeDB({ extensions })`, `@tapedb/tapedb/extension` and their types (`SchemaExtension`, `ExtensionModels`, `TapeDBExtension`, `ExtensionContext`, `ExtensionChanges`, `TapeDBCliExtension`, `ExtensionProject`, `ExtensionCommand`). They change only in a major release from here, as the rest of the stable API does; before 1.0 a breaking change bumps the minor version and is listed under "Breaking". `@tapedb/cms` is built on exactly this contract and runs on it deployed. No code changes.

## 0.5.1 - 2026-11-28

- The CLI loads a schema whose relative imports leave out the extension, as TypeScript and bundlers allow: `import { content } from "./cms.content"` finds `cms.content.ts`, dot in the name included (then `.mts`, `.tsx`, `.js`, `.mjs`, and `index.ts` or `index.js` in a directory). Node's ESM resolver wants the extension, so `migrate` stopped at the first such import; `tapedb add @tapedb/cms` writes exactly that import, so a project set up by it could not migrate. The Worker was never affected: its bundler resolves them. In a package with `"type": "commonjs"`, Node reads a `.ts` file as CommonJS, so a helper the schema imports there needs the `.mts` extension.

## 0.5.0 - 2026-11-28

- Extensions (**experimental**): a package adds to a TapeDB app in the schema, the Worker and the CLI, declared with the rest of it. `@tapedb/cms` is the first. The contract is in API.md under Extensions.

- `schema(models, { extensions })` takes `SchemaExtension`s `{ name, models, files? }`. Their models join the app's, typed, and a name clash throws. `files: { prefix, read?, write?, delete? }` rules apply under `prefix` only: a file takes the rule of the longest prefix that defines the action, else the app's `files` rule, else the default.

- `defineTapeDB({ extensions })` takes `TapeDBExtension`s. `fetch` serves the requests TapeDB does not answer, `scheduled` runs on the Worker's cron triggers (`worker` now has a `scheduled` handler), and `changes.handle` receives the change events of the models it names. Those go through the webhook outbox, so they are captured in the write's transaction, handed over after the commit in sequence order and retried while later events wait, but end in a call inside the workspace's Durable Object rather than a request: no URL, secret or public address. `/webhooks` lists each as the endpoint `tapedb-extension:<name>`. Each hook gets an `ExtensionContext`: `fetch` into the deployment in process, `signClaim` and `verifyClaim`.

- The CLI loads extensions a project lists under `"tapedb": { "extensions": [...] }` in package.json, each from `<package>/tapedb` (`defineExtension` from the new `@tapedb/tapedb/extension` entry). `tapedb add <package>` installs and lists one and runs its set-up, which may write files, add R2 buckets, cron triggers, vars and bindings to wrangler.jsonc, and add itself to the `extensions` of `schema()` and `defineTapeDB()` together with its imports; code not written as literal options is left alone and reported. `tapedb dev` runs each extension's build before it starts and again when a file the build names changes; `tapedb deploy` runs it before deploying; `tapedb build` runs it, and the auth page build, on its own. `tapedb <extension> <command>` runs an extension's commands. `tapedb init --cms` adds `@tapedb/cms` before the first migration.

## 0.4.2 - 2026-11-26

- `init` adds `@tapedb/cli` to the project, pinned to the same version as `@tapedb/tapedb`, and updating an older tapedb moves it too. Every instruction the CLI prints says `npx tapedb-cli …`, and that bin is `@tapedb/cli`'s: in a project made by `init`, which installed only `@tapedb/tapedb` (bin `tapedb`), npx resolved `tapedb-cli` on the registry and ran the deprecated unscoped `tapedb-cli` package, an old engine, instead. Projects made before this can run `npm install -D @tapedb/cli@<their tapedb version>`, or use the `tapedb:*` scripts, which were never affected.

## 0.4.1 - 2026-11-26

- 0.4.0 on npm was packed from a stale build: its `dist/` predates 0.4.0 and has none of its code (no `/metrics`, `/webhooks`, `/queries`, `$across` concurrency). 0.4.1 is 0.4.0 as tagged, built from its source. Use 0.4.1; 0.4.0 is deprecated.

- `bun run release:publish` deletes `dist/` and builds it from the tagged source before staging, and refuses if the build changes tracked files. `dist/` is ignored by git, so the clean-tree check could not see what an earlier build had left there.

- AUTH-COMPATIBILITY.md said three concurrent redemptions of one authorization code produce exactly one token. They produce at most one: Better Auth treats a reused code as a replay and revokes what it issued, so when a losing request's revocation lands first the redemption that consumed the code is refused too (`grant revoked during token issuance`). The test asserted exactly one and failed about one run in six; it now asserts at most one, every other answer `invalid_grant`.

## 0.4.0 - 2026-11-26

- `GET /engine/workspaces/:id/metrics` answers how hard one workspace is being worked: counters for writes, reads, named SQL, sockets, live queries, presence, broadcast, flushes, snapshots and recoveries; latency histograms for `query`, `transaction`, `sql`, `subscriptionUpdate`, `flush`, `snapshot` and `recovery`; and gauges read from SQLite and the socket list — connections, live queries, `storageBytes`, `txLogRows` and the durability state, including how far ahead of R2 the log is. ADMIN or higher. It carries counts, sizes and durations only: no row values, no subjects, no claims, nothing from a personal field.

- The instrumentation is in the Durable Object's memory and bounded there. Nothing is written to SQLite or R2, because a metric that cost a transaction would slow the path it measures; samples are kept as fixed buckets rather than values, so memory per timer is a constant whatever the traffic. The cost of that is a window and an approximation, and the answer states both rather than leaving them to be discovered: `restartsCounters: true`, `since` and `uptimeMs` say the counters describe one object's lifetime and start again after an eviction, `latency.estimated` and `latency.bucketsMs` say the quantiles are bucket bounds while `sumMs`, `maxMs` and `meanMs` are exact, and `measurement` labels every field `measured` or `estimated` so a dashboard cannot present an estimate as a reading. Every timer records failures as well as successes: a flush that never reached R2 is the sample most worth having.

- `/metrics` leads with `health`: `ok`, `degraded` or `failing`, and one coded reason per problem (`recovering`, `recovery_failing`, `flush_failing`, `flush_lagging`, `snapshot_overdue`, `webhooks_dead_lettered`, `write_latency_high`, `live_updates_slow`). It is computed only from numbers the answer already carries, so it costs nothing and a reader can check it. `gauges.durability` gained `oldestPendingAt`, `snapshotCompletedAt` and `snapshotDueAt`, which the lag and overdue rules read. `db.$metrics()` returns `health`, or null from an older Worker.

- `TxResult` gained an optional `deduped: true`, set when a `clientTxId` was answered from an existing receipt. `applied: 0` alone could not tell a replay from a no-op delete, which a client retrying a write also wants to know.

- `bun run bench` (`scripts/bench.ts`) measures the engine: writes at four
  batch sizes, bulk writes, the dedupe path, thirteen read shapes from an
  indexed lookup to a named SQL query with a CTE, invalidation cost as live
  queries multiply, flush, snapshot and recovery at two workspace sizes with
  and without a snapshot to start from, and bytes per row. Exact quantiles
  from kept samples, reproducible from `--seed`, configurable with `--rows`,
  `--iterations` and `--only`, and `--json` records the run with the
  environment and version that produced it.

- The load scenario takes `BENCH_JSON` and records what a Worker and a socket
  actually serve. The two suites are reported apart, and labelled in their own
  output, because only one of them can speak about a deployment: bun's SQLite
  allows 32,766 bound parameters against a Durable Object's 100, R2 is a `Map`
  in process, and nothing local pays for the runtime, the socket or a cold
  start. Neither asserts a threshold — a benchmark that failed a target
  invented in this repo would be measuring the machine it ran on.

- BENCHMARKS.md records a run of each, four bottlenecks and the operating
  guidelines that follow from them. The contrast is the useful part: the
  engine inserts a row in 0.022 ms, and a client observes the same write
  107 ms later. Live queries are a per-write tax a single-threaded object pays
  before serving the next request (100 of them add about 18 ms to every
  write); `patchMany` is the most expensive write by an order of magnitude; an
  unindexed filter costs about 7x an indexed one at 20,000 rows and the gap
  grows; cursor pagination does not degrade with depth.

- `bun run bench:e2e` widens the load scenario into a suite: writes at three
  concurrencies and three transaction sizes, a contended row, bursts and a
  sustained load; eleven reads through the client at two sizes; live-update,
  presence and broadcast fan-out at 10/50/200 sockets; how far R2 trails
  commits under load, from `/metrics`; and many workspaces, from first touch to
  `$across` at 10, 100 and 1,000 with a refused token. It runs against `tapedb dev` or
  a deployed Worker, records every measurement with its environment in one
  file, and `scripts/bench-report.mjs` renders it. BENCHMARKS.md gains its run
  and four more bottlenecks: presence fan-out growing with the square of the
  room, one writer saturating past about four concurrent writers, R2 trailing
  commits by up to the 30 s alarm delay, and first-touch and per-workspace
  `$across` cost.

- `bun run typecheck` now covers `scripts/` as well as `src` and `test/types`,
  and `scripts/soak.ts` runs again. It had been broken since the deployment
  config stopped being a module global: `runTransaction`, `recordFileEntry`
  and `forgetFileEntry` gained a required argument, and the soak is a script
  rather than a test, so nothing failed. `test/fixtures/test-support.ts` was
  importing two types from a file that does not exist, which a type-only
  import hides from bun entirely. `@types/bun` is a new devDependency so the
  scripts can be checked against bun's own published types rather than a
  hand-written shim.

- `$across(ids, { concurrency })` bounds how many workspaces a one-off read asks at once, claims included. The default is 64, chosen from a deployed run: at 1,000 workspaces it read as fast as unbounded (3.9 s against 4.0 s p50) where 16 took 11.2 s. Before, every workspace's request and claim started together: 1,000 workspaces meant about 2,000 simultaneous requests from one client (docs/adr/0001-cross-workspace-reads.md). Live queries still open one socket per workspace.

- `$across` uses a `getToken` given after a call for the same workspace without one. It kept one client per workspace, and a client first made without `getToken` (the development claim route) kept using that route, so the later call's tokens were never sent. It now keeps one client per workspace and token source.

- Three admin routes for operating the webhook outbox, and `db.$webhooks()`, `db.$webhookDeliveries()` and `db.$webhookRetry()` to reach them. `GET /webhooks` reports each endpoint's counts, whether it is backing off, and the one delivery it is waiting on — which, because nothing overtakes a failing event, is the whole explanation of a stalled endpoint. `GET /webhooks/deliveries` lists the same bookkeeping per delivery. `POST /webhooks/retry` makes deliveries due now, by id or by a bounded filter. ADMIN or higher: a retry sends data to a third party.

- A retry re-queues the existing outbox row rather than capturing a new event, so the event id, the sequence and the signed body are the ones first captured; nothing re-reads the database, so a retry cannot pick up a row's later state and pass it off as the original change. The attempt count and age window restart (recorded as `revivedAt`), because a dead event has exhausted both and re-queuing one without resetting them would be a no-op dressed up as a retry. A revived event keeps its sequence, so it becomes its endpoint's head again and that endpoint's newer events wait behind it until it lands — the ordering guarantee doing its job, and worth knowing before reviving something old. A delivered event is never re-sent, even when named by id, because the engine cannot tell a deliberate redelivery from a duplicate.

- The inspection routes never return the signed body. It holds the row's non-personal values and was written for the endpoint rather than filtered through the caller's read rules, so returning it would show an admin row values their own rules may hide. What comes back is what the event was about, not what it contained.

- An endpoint the deployment has since dropped is still reported, with `retired: true` and the url its queued events carry. Those events can no longer be signed, so they dead-letter; hiding the endpoint would hide why a count never falls.

- The outbox gained a `revived_at` column, added in place for workspaces whose outbox predates this. The outbox is local Durable Object state — not in `ENGINE_TABLES`, so neither snapshotted nor restored — which is why this is not an engine migration: there is no other copy to keep in step.

- Query profiles. `db.$queryProfile()` (`GET /engine/workspaces/:id/queries`, ADMIN or higher) lists the read statements that have cost a workspace the most: typed reads, live queries and named SQL, each with its run count, rows returned, rows SQLite read (from the Durable Object cursor, which is what Cloudflare bills), and wall time. Each comes with SQLite's own plan, the model tables it scanned whole, and the columns it compared on them as candidates for `.index()`. Statements are recorded by their SQL text, whose values are always bound, so no filter value is kept. The record is in memory, bounded to 200 statements, and starts again with the object. `reset: true` clears it. Nothing changes an index or a migration.

- AUTH-COMPATIBILITY.md, shipped in the package, says which Better Auth capabilities work on tapedb's adapter and how that was checked. `scripts/auth/plugins.vitest.ts` (part of `test:auth`) runs real flows in workerd against the AuthRoom: session revocation, a ban ending sessions, magic link, TOTP and backup codes, organizations and roles, JWT and JWKS, the OAuth 2.1 provider (registration, authorization code with PKCE, refresh-token rotation with reuse detection, revocation), device authorization, and passkey registration options. Every single-use step is raced by concurrent requests and must succeed exactly once. With a deliberately non-atomic `consumeOne`, six of those tests fail. Flows Better Auth writes inside `runWithTransaction` (organization member changes, OAuth client registration, passkey registration with a session) are listed as able to leave partial writes, since the adapter has no multi-call transactions. Account linking and a full WebAuthn ceremony are listed as not verified. `@better-auth/oauth-provider` and `@better-auth/passkey` are new devDependencies, for the tests only.

## 0.3.6 - 2026-11-22

- Named SQL queries. `schema(models, { queries: { name: sqlQuery({ sql, params, returns, role?, bypassReadRules? }) } })` declares a SQLite statement in the schema file, and `db.$query(name, params)` runs it, typed from `params` and `returns`. Use it for what the query builder cannot express: recursive CTEs, window functions, joins with their own grouping. A request names a query and passes values, which are always bound; the client never sends SQL.
- The engine runs a named query read-only: one `SELECT` (or `WITH … SELECT`, or `VALUES`), inside a transaction that is always rolled back. Before the first run it reads SQLite's own plan for the statement (`EXPLAIN`), so it knows every table and column read, through CTEs and subqueries, and refuses engine tables, `sqlite_schema` and personal fields. Each run checks the query's `role` and, for every model read, that its read rule is a role the caller meets; a model with a `filter()` or `check()` read rule needs `bypassReadRules: true` and filtering in the SQL with `:authSub` and `:authRole`, which the engine binds from the claim. Results come back in API form and must match `returns` exactly, with null only in optional columns.
- `migrate check` and `deploy` prepare every named query against the tables the migrations build, with the engine's checks, so a renamed column or a refused read fails in CI rather than on a request. New route `POST /engine/workspaces/:id/sql` and error codes `unknown_query`, `invalid_query_params`, `query_refused`, `query_failed`, `query_forbidden` and `query_result_mismatch`.
- Named queries are one-off reads of one workspace; they do not take part in live updates.

## 0.3.5 - 2026-11-21

- No runtime change: this release corrects what 0.3.4 said about itself. 0.3.4 shipped with no changelog section and an empty GitHub release body, and `README.md`, which ships in the tarball, closed its vector section by saying that embedding generation stays with the application, that tapedb never calls a model, and that text-to-vector and hybrid search were not part of the release. The section above it documents all three, and `API.md` does too. The paragraph now says what a write calls and what a search calls, and names the three things that really are absent: subscriptions to search results, ranking across workspaces, and providers other than Vectorize.

- `API.md` no longer lists `VectorizeOptions`, `VectorIndex`, `VectorRecord`, `VectorIndexMutation`, `VectorQueryOptions`, `VectorQueryResult`, `VectorMatch` and `VectorIndexDescription` as experimental. 0.3.4 removed the tag from those types and the inventory paragraph was not updated with it.

- The two doc comments that generate the API reference no longer mark `search` or the `vectorize` option experimental, and the `vectorize` block documents `embed`, `keywordFields` and `rerank` instead of saying search is not part of the option. `api/surface.json` records the new shapes, and the public-surface test fails if any `Vector*` or `Search*` export is tagged experimental again.

- The docs site gates its generated API pages: the generator's `--check` mode compares every page with what the current package build produces and refuses when the build is older than the source, so a reference from a previous release cannot deploy.

## 0.3.4 - 2026-11-21

- `db.<model>.search({ text })` searches with words. The deployment embeds the query itself through the Workers AI binding named by `vectorize.embed` (default `@cf/baai/bge-base-en-v1.5`), so the question and the corpus go through one model and the caller never runs one. `text` and `vector` are alternatives and sending both is refused; empty or non-string text is refused before the binding is called; a configured binding missing from `Env` answers `503 vector_search_unavailable` naming it; an embedder that throws answers `storage_error` with retry guidance instead of an empty answer that reads as nothing matched. The resulting vector goes through the validator a write uses, so a length that disagrees with the declared dimensions fails with the write's own message.

- `vectorize.keywordFields` adds exact-term recall to a text query. Up to five string attributes of the indexed model are mirrored into an FTS5 table, `_vector_keyword`, in the workspace's own SQLite and maintained by triggers inside the write's transaction. The query's words are tokenised, quoted and OR-ed, so `AND`, `NEAR`, `"` and `-` in a search string are words rather than syntax. The vector list and the keyword list are fused by reciprocal rank (k = 60), and a row in both outranks a row at the top of only one. A keyword hit does not require a current vector digest, which is what makes two rows findable by their words: one whose text changed after its vector was published, and one written a second ago whose vector is still pending. Requires `embed`.

- `vectorize.rerank` scores each candidate's passage against the question with `@cf/baai/bge-reranker-base` and its order replaces the fused one. A reranker that fails leaves the retrieval order and answers `reranked: false` rather than failing the search or passing an unranked answer off as ranked. Requires `embed` and `keywordFields`, because the passages it scores are those fields.

- `search.mode` and `search.reranked` say what a score means: `vector` is the provider's cosine, `hybrid` is a fused rank comparable within one answer only, and `reranked` marks an order produced by the reranker. Leaving `score` documented as cosine while sometimes returning a rank was rejected; changing a documented meaning silently is the defect, not the change. Vector search, `search` and their types leave the experimental set: one indexed model per deployment and one provider stay documented scope rather than an instability.

- Erasing a workspace with `keywordFields` no longer fails. The wipe deleted every table it found, including FTS5's shadow tables, which refuse a direct `DELETE`, so erasure answered `Erasing did not finish (table _vector_keyword_data may not be modified: SQLITE_ERROR)`. It now finds virtual tables, excludes their shadows from both the delete and the drop loops, and drops the virtual table so its shadows go with it. Found while tearing down the benchmark deployment, which is when an erasure has to work; `test/vector-hybrid-search.test.ts` now erases a configured workspace.

- Search is measured rather than described. `scripts/bench-vector.mjs` runs against a real deployment and exits non-zero rather than reporting timings from empty answers: an early run claimed p50 242 ms with `rows: 0` because the provider had not made the batch visible yet. On 200 notes with `embed`, `keywordFields` and `rerank`: text queries p50 504 ms, p95 775 ms, max 1973 ms (two Workers AI calls plus the read); vector queries p50 182 ms, p95 239 ms, max 242 ms. The same run measured 200 vectors accepted in about 20 s and searchable after more than three minutes, against 52 to 69 s for a single row.

- `scripts/e2e-vector.mjs` (`bun run test:e2e:vector`) exercises the provider through a remote Vectorize binding in workerd, since workerd has no local emulation, and asserts the binding is `remote` before asserting anything else so a local one cannot make the run pass vacuously. It leaves a shared index as it found it. The pilot record, including DEP-06 (a deployment that already has workspaces) and the provider's metadata-index lag, is in `docs/`.

- A `filter()` read rule that names a relation compiles with the model graph again. `toEngineWhere` received `graph[key]` without the graph, so a branch naming a relation threw on `graph[relation.target]` being undefined, and a throwing rule renders as `0 = 1`: a silent deny-all that refused creator and grantee alike with no error anywhere. Found building artist-archive, where a per-object ACL rule hid every row. Regression: `test/access-filter-relations.test.ts`.

## 0.3.3 - 2026-11-20

- `tapedb deploy` provisions the vector index instead of leaving it to the app. A deployment declares what it indexes in `tapedb.vectorize.json` (model, field, filter fields); the CLI validates it against the schema, derives the index name from deployment identity, creates the index and one metadata index per filter, records ownership of what it created, and writes the binding the Worker reads. A repeat deploy, two concurrent deploys and a retry after a failed upload converge on one index. Every later deploy reads the live index and refuses to upload on a wrong dimension count, another metric, a metadata index of the wrong type, or an ownership record naming another account or worker, naming both values and deploying nothing. An index that exists without a record is refused rather than adopted; naming it with `index` in that file records it. `eu` and `fedramp` deployments refuse vector search before provisioning, because Vectorize cannot meet that residency and an index cannot be redeployed out of a jurisdiction.

- One workspace's index has an operator surface. `POST …/vector/retry` requeues failed and dead-lettered intents without changing what the provider is expected to hold, because the next drain recomputes each row from the database. `POST …/vector/rebuild` starts, or joins, one crash-resumable job per workspace: it forgets the accepted digests so every row is sent again, turns accepted entries whose row is gone into deletes, enqueues in bounded batches from a cursor in the workspace's own SQLite, and finishes when the queue is empty. Concurrent requests get one `jobId`. `POST …/vector/rows` reports `unindexed`, `pending`, `indexed` or `failed` for rows the caller may read, and omits a row the caller cannot see so it is indistinguishable from one that does not exist. While a rebuild runs, search for that workspace answers `503 vector_search_unavailable` with `retry-after: 30`, and `GET /status` reports the job under `vectorize.rebuild`. All three routes need admin or owner; a member is refused before learning whether vector search is configured.

- `db.<model>.search({ vector })` answers a nearest-neighbour query over the vector field a deployment indexes. The index proposes candidates; every one is re-read from the workspace's own SQLite through the same path a `findMany` takes, so `view`, `where` and row-level rules decide what comes back, an id the database no longer holds is dropped, and a row whose embedding or filter value changed after it was published is dropped rather than ranked on a vector it no longer has. Rows come back nearest first with the score they were found by, and `truncated` says whether the index had more to give. `limit` defaults to 10 and 50 is the ceiling — the provider's limit for a query that returns metadata — with a larger number refused rather than clamped. `filter` is equality on the deployment's declared `filterFields`, applied before the ranking, and an undeclared attribute is refused. The answer is not live and not cached: one provider query and one SQLite read per call.

- `defineTapeDB({ vectorize })` publishes one model's `t.vector({ dimensions })` attribute to a Cloudflare Vectorize index. The intent is committed with the write by a trigger inside its transaction, in the workspace's own SQLite, and drained from the durability alarm, so an index that is slow or down costs a retry and never a commit. Each publish carries a digest over the model, the row, the vector's canonical bytes and the values of the configured filter attributes, so a row whose only change is an indexed filter value is re-sent — a metadata filter evaluated at the provider would otherwise go stale while SQLite says otherwise — and a row that changed nothing is not sent at all. Batches are the platform's: 1,000 vectors per upsert for the Workers binding. Visibility is asynchronous and was measured 73–103 s behind an accepted upsert, so `pending` is the normal state, the mutation ID is recorded for correlation, and nothing assumes the provider's watermark moves forward. `GET /status` counts pending, failing and accepted rows.
- `GET /status` separates the three vector work states an operator has to tell apart — `pending`, `failing` and `deadLettered` — and adds `fenced` plus the purge's own phase for a workspace whose erasure is under way or outstanding. An intent that has failed twelve times stops being retried and stays counted, so an index that has been unreachable for hours reads as dead-lettered rather than as a queue that is merely busy.

## 0.3.2 - 2026-11-20

- 0.3.1's own notes said erasing a workspace's vectors was "not covered" while the same section described the purge that ships in it. `API.md` repeated it. Both are corrected here, and the erasure is documented where it belongs: the fence, the delete's mutation-id confirmation, resumption from the ledger, and the restore rule.
- `GET /status` documents the three vector work states it already reports separately — `pending`, `failing` and `deadLettered` — plus `fenced` and the purge's phase.
- A room addressed by something other than a workspace id no longer asks R2 for a purge marker it cannot have, and a restore reads the fence only when its bookkeeping names another workspace.

## 0.3.1 - 2026-11-20

- `t.vector({ dimensions })` is an embedding field: a fixed-length list of numbers from 1 to 1,536 dimensions, validated at definition time. A write checks the length, requires every element to stay finite as float32, stores `-0` as `+0` and refuses an all-zero vector. The stored value is one string, `f32le:v1:<base64>`, so a row is byte-identical through SQLite, the log, a snapshot, `$export` and backup. Embeddings are left out of default projections and cannot be filtered, sorted, grouped or aggregated.
- `defineTapeDB({ vectorize })` mirrors one model's vector attribute into a Vectorize index. Index work is queued in the workspace's own SQLite inside the write's transaction and drained from the durability alarm, so a commit never waits for the index and a failed drain retries with backoff. A digest over the row id, the stored bytes and the filter values decides what to send: an unchanged row is not re-sent, and a changed filter value still republishes its metadata. Row deletes enqueue a delete of that row's vector.
- Search a model by nearest neighbour: `db.model.search({ vector, limit, filter })` returns the rows with their `score`. The query vector goes through the same codec a write does, so a wrong length fails with the write's message; every returned id is read back from the database, so a vector whose row was deleted or erased is dropped rather than surfacing a row that is gone. `limit` defaults to ten and fifty is the ceiling — a larger value is refused, and the answer reports whether it was truncated. Filters are limited to the fields the deployment declared, and a search runs under the caller's own read rules.
- `@tapedb/react-native` is the runtime package: `AsyncStorageOutbox` and `createReactNativeClient`, and nothing else. It peers on `@react-native-async-storage/async-storage` only. **Breaking:** it no longer re-exports the React hooks and no longer peers on `react` — the hooks are `@tapedb/react`, the same module on web and on device.
- Erasing a workspace purges its vectors. A durable marker in the data bucket is written before anything is deleted and read immediately before each submission, in the same step, so a paused drain and a retry recovered after the room was evicted cannot send an upsert past the fence. Deletion is confirmed against the delete's own mutation id, because the provider's watermark is not monotonic across replicas and its read path goes quiet long before the watermark arrives. A restore re-derives the identity it publishes under, so a backup restored into another workspace cannot carry vectors that were erased under the source.

## 0.2.3 - 2026-11-20

- The client runs on React Native. `topicOrigin` was initialised with `crypto.randomUUID()` and the socket id generator did the same, and React Native has no Web Crypto, so constructing a client threw before the first render. Both now use the fallback the id generator already had.
- The React Native examples now pass the required `workspace`, and `$flush()` is described as it behaves: one delivery attempt that resolves when it finishes, not a wait for acknowledgement. Offline it resolves with the queue unchanged, so it is "try now", not "is synced".

## 0.2.2 - 2026-11-20

- React Native clears its queue again on `@react-native-async-storage/async-storage` v3. v3 renamed the batch delete from `multiRemove` to `removeMany`, so `clear()` threw, was caught by the fallback, and left every entry on disk while reporting an empty queue — a silent leak of queued writes in an app that looks clean. The adapter now takes whichever batch delete the installed release offers, or neither and deletes one key at a time, and the peer range covers v1, v2 and v3.
- Deployment configuration no longer lives in module-level variables. `audit`, file rules, realtime settings, webhooks and the log part size were module-level `let`s that the last `defineTapeDB` in a process overwrote, so a second deployment inherited the first one's settings. Configuration now travels with the room that owns it, so two deployments in one process keep their own settings.
- `CONTRIBUTING.md` now says what a double may and may not stand in for, and that a feature speaking a protocol is not covered until `scripts/e2e/` exercises it in workerd.

## 0.2.1 - 2026-11-20

- React Native keeps its offline writes. The queue was IndexedDB-backed and RN has no IndexedDB, so a write made offline there was fire-and-forget and nothing survived a restart. `createClient({ outbox })` now accepts `Outbox | OutboxFactory`, and `@tapedb/react-native` supplies `AsyncStorageOutbox` — one key per entry under a prefix, ordered by `createdAt` rather than by key order, with a retry replacing its own entry — plus `createReactNativeClient`, which wires AsyncStorage by default. The package peers on `@react-native-async-storage/async-storage` and `react` and does not import `react-native`.
- The 0.2.0 README claimed `npx @tapedb/cli` brings the project's `@tapedb/tapedb` up to the same version. It does not: the wrapper resolves the core from its own pinned dependency, so it runs that release's CLI and leaves the project's copy alone. The paragraph now says what the pin does and why in-project hints read `npx tapedb-cli`.
- API.md contradicted itself about presence: the section on presence said peers include the caller and refusals reach `onError`, while the hooks table still said the caller is left out and one paragraph still claimed there is no error channel. Both were leftovers from the fixes in 0.2.0; the statements now agree everywhere.

## 0.2.0 - 2026-11-20

- Filters gain the three operators InstaQL had and tapedb did not: `$isNull`, `$like` and `$ilike`. `$like` compiles to GLOB rather than LIKE, because SQLite's LIKE is case-insensitive for ASCII and a case-sensitive operator that silently is not would be worse than none; `$ilike` folds with `LOWER()` and is therefore ASCII-only, which the docs say rather than implying otherwise. Both refuse a non-string field and a relation.
- Presence holds several rooms per socket, capped by `realtime.maxPresenceRooms` (4 by default; `1` restores the single-room behaviour, `0` refuses presence), with an 8 KiB per-socket state budget. `client.clientId` names the socket's own session. `realtime.authorize({ auth, kind, target, action })` authorizes presence and topics through one function, called before any state is stored, so a refused join leaves nothing behind; `topics.authorize` stays as a deprecated alias.
- Presence peers include the caller, marked `isSelf: true`, and `{ includeSelf: false }` restores the old list. The previous default dropped your own entry, which meant every app's own cursor vanished on upgrade — a breaking change dressed as a fix. `usePresence` had been reading the same option the opposite way; both now agree, and a parity test holds them together.
- A presence refusal used to be a frame the client dropped. The engine now names the room it refused and the client routes it to `onError` on the subscription; the room keeps its last state and the subscription carries on, so the callback is how an app explains a refused cursor instead of leaving the caller to infer it from one that never appears.
- Broadcast subscriptions report a gap when the replay window no longer holds what a reconnecting listener missed: `onGap` receives `{ topic, expected, received }`, and `lastSeq` and `gap` let a caller resynchronise. Own messages never count as a gap and an exact resume reports none. It reports loss; it does not recover it. Broadcast remains experimental.
- `tapedb backup --workspace <uuid> --url <url> --out <dir>` writes a `backup.json` manifest with a sha256 per part, `rows.ndjson` and `files/<path>`; `tapedb restore --from <dir> [--into <workspace>] [--dry-run]` verifies every hash before writing anything, refuses a non-empty destination and checks the row count.
- `defineTapeDB({ webhooks })` delivers signed change events to an endpoint. Changes are captured by triggers inside the write's own transaction and sent after commit from the durability alarm, so a webhook can never fail a commit. `X-Tapedb-Signature: t=<unix>,v1=<hex>` is HMAC-SHA256 over the timestamp and the exact posted bytes. Delivery is at-least-once and ordered per workspace by `seq`, retried with exponential backoff capped at 30 minutes, then dead-lettered after 24 hours and counted. Personal fields never appear in a payload.
- `defineTapeDB({ limits })` sets per-model and per-workspace write budgets. Counters live in the workspace's own SQLite so they survive eviction, the window is fixed rather than smooth (a caller can spend a full budget at each edge of a window, and the source says so), a refused write is `rate_limited` with the limit, the window and `retryAfterMs` as a 429 with `Retry-After`, an invalid or failed write is refunded and a deduped retry is not charged twice. A deployment without the option creates no table.
- An opt-in HTTP API for backends: `POST /v1/query`, `/v1/transact` and `/v1/claim` behind `authorization: Bearer <token>`, compared in constant time. Every request names the identity it acts as and the engine evaluates the same role, `filter` and `check` rules it would for a socket holding that claim — deliberately not an admin claim that skips rules, because one leaked token would then read every row in every workspace. Without the option the routes 404 rather than 401, so a deployment is not discoverable through them, and admin writes pay the same budgets.
- Every public entry has one scoped name: `@tapedb/cli`, `@tapedb/react`, `@tapedb/auth` and `@tapedb/email`, each pinning the core exactly so a wrapper cannot drift onto an older release. The subpaths (`./react`, `./auth`, `./email`, `./schema`, `./worker`, `./studio`, `./seed`) still resolve to the same module and nothing was removed. `tapedb-cli` is superseded by `@tapedb/cli` under the same bin name.
- A whole-row update could be recorded as an insert. Insert and update were told apart by comparing `created_at` with `updated_at`, which are the same millisecond on an insert, so an update in that millisecond read as a creation — visible in `$history` and the log since the log reader was introduced. The write path now records `created` on the entry and the timestamp comparison survives only as a fallback for entries written before it; those can still be wrong inside that millisecond.

## 0.1.30 - 2026-11-18

- The default auth page uses the Studio brand: cassette mark, signal orange, Space Grotesk/Inter/JetBrains Mono, responsive light/dark layout and reduced-motion support. Email links, passwords, registration and resets have separate focused states.
- A default React component in `tapedb.auth.tsx` replaces the auth page. `dev` watches its imports, `deploy` builds its browser bundle, and `auth build` supports custom pipelines. CSS and local assets are bundled. New auth scaffolds are pre-wired; React is loaded only for a custom page. Components receive a same-origin `redirectTo` prop.

- Optional Better Auth adapter at `@tapedb/tapedb/auth`, backed by one dedicated SQLite AuthRoom for users, sessions, accounts and verification tokens. Single-use token consumption and counter increments are atomic. The official adapter suites run as part of verify.
- `defineTapeDB({ auth })` serves `/api/auth/*` and derives workspace claims from sessions and stored membership. Explicit workspace creation assigns its owner; claims cannot bootstrap membership. Owners manage roles, with last-owner protection.
- `t.belongsTo("$users")` adds managed member profiles to the workspace, using the normal taped transaction and personal-data erasure paths.
- Cloudflare Email Service mailer at `@tapedb/tapedb/email`; local auth setup captures messages in the terminal and Studio instead of sending them.
- `init --auth --email-from <address>` scaffolds verification, reset and magic-link mail, installs Better Auth, generates the auth secret, and adds the AUTH and EMAIL bindings. Deploy onboards the sender domain and keeps existing secrets. Studio has a Users page for sign-in, membership, sessions and account erasure.

## 0.1.29 - 2026-11-18

- `migrate squash` no longer refuses a run that contains a table rebuild. Adding a constraint to an existing table cannot be done in place, so the generated migration creates `<table>__rebuild`, copies the rows into it, drops the original and renames; those inserts are migration mechanics, not a backfill, and the fold now reproduces them instead of rejecting them.
- The fold expands rebuilds the way `migrate dev` does, so a net change that adds a reference or changes a type comes out as the same statements a fresh migration would contain.
- `migrate squash --name <what>` renames the folded migration, because the first migration of a run is often a name that no longer describes it.
- The model graph is a workspace view, opened from the tools beside Query, Access and History, instead of a tab inside a model. A global diagram filed under a model claimed a scope it did not have: the tab did nothing when another model was chosen.
- The graph's layout stacks each column from the heights already placed in it and centres the columns, so nodes no longer overlap; edge labels carry their own background at a readable contrast; the minimap is replaced by a footer strip with the reading key and the model and relation counts, which cannot cover a node.

## 0.1.28 - 2026-11-18

- The studio draws its own controls: one listbox replaces every native select (the field sheet, the filters, the relation picker, the role picker, the history filter and the workspace picker), with Arrow/Home/End/Escape, aria-expanded and aria-selected, and a hidden input so existing callers keep reading `value`. The checkbox keeps the real input for semantics and `.checked`, with the brand's box beside it.
- The studio has a Graph tab: React Flow renders a node per model with its fields, keys, foreign keys and types, and an edge per foreign key labelled with the field and `many → 1`, laid out by dependency depth. Clicking a node opens that model. React, React DOM, React Flow and esbuild are devDependencies and the bundle is committed as a string, so the studio is still one response with no build step and no network, and `@tapedb/tapedb` still has no runtime dependencies.
- The graph's stylesheet joins the page's single style element, because the studio ships a hash-based Content Security Policy; literal script tags inside the bundle are escaped so they cannot end the page's script element early.

## 0.1.27 - 2026-11-18

- `tapedb migrate squash --since <id>` folds that migration and everything after it into the first one, re-deriving the SQL from the snapshots at each end of the run so the result is the net change. The first migration keeps its id, so a development database that already applied the run needs no repair. A run whose net change is nothing is removed rather than left as an empty file, and a run containing a statement that touched rows is refused because a re-derived diff cannot carry it.
- The studio reads and writes `t.enum([...])`: the Structure tab shows the allowed values instead of the field's source, the field form offers the enum type with a values input, and a default outside the set is refused.
- The default control in the field form follows the type: a list for `boolean` and `enum`, a number control for `number`. A text box let the form ask for a value the field cannot hold.
- A test now parses the studio page's inline script, which nothing type-checks.

## 0.1.26 - 2026-11-18

- `t.enum([...])`: a string with a closed set of values. The column stays TEXT and the migration snapshot records only the type, so adding or removing a value needs no migration; the engine refuses a write outside the set with `invalid_value` and lists the values it accepts. `Row`, `CreateData` and `where` narrow to the union, so a typo fails in the editor before the engine sees it.
- `default`, `index`, `unique` and `optional` work on an enum as they do on a string, `default()` rejects a value outside the set, and `personal()` throws: the set is public and the check compares plaintext. A seeder reads the set from `ctx.model(name).fields[field].values`.
- Use it for sets the application owns (status, kind, channel) and not for codes an external standard owns (currency, country), where every addition would be a schema edit.

## 0.1.25 - 2026-11-18

- `@tapedb/tapedb/seed` and `npx tapedb-cli seed`: a seeder is a `tapedb.seed.ts` of plain TypeScript, and the library supplies the bookkeeping around its values. The context offers `create`, `insert`, `listIds`, `ref`, `unique`, `clear`, `model`, `rng`, `rngFor` and `written`; rows are written one transaction per 500 through the engine's own routes, so claims, access rules, the tape and the history behave as they do for a client. Declared defaults are filled in, because the engine wants every column named. A `personal()` field is refused rather than written in the clear, since the encryption key belongs to the application.
- The same `--seed` writes the same rows, and `rngFor(label)` gives a stream that depends only on its label. `rng.past()` and `rng.future()` measure from now, so pass `from` to anchor a date that has to survive tomorrow.
- `tapedb seed --workspace <uuid>` takes `--dry-run`, `--if-empty`, `--model`, `--file` and `--seed`, and refuses a target that is not localhost without `--force`. `loadSchema`'s loader is now `loadProjectModule`, so a seeder loads the same way a schema does.

## 0.1.24 - 2026-11-18

- `createdAt`, `updatedAt` and `updatedSeq` resolve on every read path, not only in `select`. A read can now order, filter and group by them, and the client's `where`, `orderBy`, `groupBy` and aggregate types accept them, so a call no longer passes the client and then fails with `unknown_attribute` at the engine. `updatedSeq` gives "what changed since" as a total order. They stay engine-owned: a create or update that names one is still refused.
- The studio's favicon carries the brand's light and dark pair and follows `prefers-color-scheme`, instead of the dark-theme colours hardcoded on a light tab strip.

## 0.1.23 - 2026-11-17

- Literal schemas report missing relation targets, missing or ambiguous hasMany inverses, invalid inverse names, and missing or invalid personal subjects in the TypeScript editor. Subject and inverse names remain precise through their builders and modifiers. Dynamic definitions still use the existing runtime validation; emitted runtime JavaScript is unchanged.


## 0.1.22 - 2026-11-17

- The studio has a History page: the transaction log, newest first and live, filterable by model, for admins and owners. Each transaction shows what it wrote per model ("task: 5,000 created"), and opens to its operations, row by row with links to the rows, and the values written. With `audit: true` it names the writer and role.
- Values in the history are shown only for models whose read rule is a role the caller meets; for a model with a filter or check read rule, only which fields were written. Personal fields never show a value. Workspaces with personal fields log whole rows after each write; the history reads those as creates, updates and deletes.
- A row's panel lists its changes (with `audit: true`), each linking to its transaction; its last write opens the same way, and so does the counter on the transaction tape.
- New route `GET /engine/workspaces/:id/log` (ADMIN or higher), described in API.md.

## 0.1.21 - 2026-11-17

- The studio has an Access page: each model's read, create, update and delete rule and the files' rules, with the roles a role rule lets through, what a filter rule narrows reads to for the signed-in caller (as a filter in words, such as `done = false`), and under `tapedb dev` each rule as written in `tapedb.schema.ts`.
- The studio can show a workspace as someone else. Under `tapedb dev`, pick any role and user id; on the deployed Worker, your own user at your role or a lower one. The data, counts, query console and Access page then show what that caller sees, and writes go through their rules. A reload starts as yourself again.
- `POST /_tapedb/claim` takes an optional `role`: a claim at the caller's own role or below it, never above (403 `role_above_membership`). The development route also takes `role` and `sub`.
- The schema endpoint reports `access` per model (filter rules evaluated for the caller), `files` rules and the `caller`.

## 0.1.20 - 2026-11-17

- The studio exports a model's rows as CSV or JSON: all of them, the ones a search or filter shows, or the selected ones. Every field is written, dates in ISO 8601, null as an empty CSV cell; CSV is RFC 4180 with a byte order mark, so spreadsheets read it as UTF-8.
- The studio imports CSV and JSON into a model. Before anything is written it checks every value against its field and lists what to fix by row, and says how many rows it creates, how many existing rows it updates (by id), and which columns it leaves out. Rows with an id are upserts, rows without one are created with the field defaults; up to 5,000 rows go in one transaction, larger files in transactions of 5,000.

## 0.1.19 - 2026-11-17

- The studio has a query console. It runs one client call as written in app code (`db.<model>.<method>({ ... })`), read as data and translated by the client's own model code, with the studio's sign-in and access rules. It suggests models, methods, arguments and fields as you type, marks where a call stops making sense, keeps recent calls, and shows results as a table, a count or the JSON the call returns.
- Writes from the console say what they change before they run: how many rows `updateMany` sets and to what, what a delete takes with it (cascade, cleared fields, or refused), or that no row has the id given.
- The model client's translation of each method lives in one place, used by the client and the console alike.
- The schema endpoint marks personal fields (`personal: { required }`) and reports their defaults.

## 0.1.18 - 2026-11-17

- The studio's table has checkboxes. Select rows, or every row shown, and delete them in one transaction.
- Before any delete, from the table or a row, the studio says what it does to rows that point at it, from each relation's `onDelete`. It also deletes rows that belong to it (cascade), clears the field on others (set null), or is refused while rows still point at it (restrict), with the counts.
- Text, number, true/false and date cells edit in place with a double-click. Edits are staged and marked until "Save changes" writes them all in one transaction, or "Discard" drops them. An arrow at the start of each row opens the row panel.
- "Columns" hides and shows columns per model; the choice is kept in the browser.
- Search finds rows whose text fields start with what you type (case sensitive), or the row with that id.
- The schema endpoint reports each relation's `onDelete` under `links[].foreignKey`.

## 0.1.17 - 2026-11-17

- With `studio` passed to `defineTapeDB`, the deployed Worker's own address (`GET /`) opens the studio instead of answering `no_route`. After deploying such a Worker, `tapedb deploy` says where the studio is.

## 0.1.16 - 2026-11-17

- The studio for deployed apps: `import { studio } from "@tapedb/tapedb/studio"` and pass it to `defineTapeDB`, and the Worker serves the studio at `/_tapedb/studio`. It signs in with the app's own session through `/_tapedb/claim`, so the identity adapter decides the role (shown as "Signed in as Owner"), and every read and write passes the app's access rules. Workspaces are opened by id, from recent ones, or with `?workspace=<id>`, and the deployed Worker lists none. The structure is read-only there. The page runs under a content security policy with hashes for its one script and one stylesheet. Without `studio` nothing is served at that path, and the page and fonts are left out of the Worker. `tapedb init` adds it to new projects.
- The schema endpoint reports each field's default.
- The studio's fonts are compiled into the package instead of read from `assets/fonts`; only the font licence ships there now.

## 0.1.15 - 2026-11-17

- The studio edits the schema. Each model has a Structure tab listing its fields: their types, relations, defaults and indexes. From there you can add, edit, rename and delete fields, and create, rename and delete models; deleting a model also removes the relations and access rules that name it. Every change is previewed first: the edit to `tapedb.schema.ts`, the migration SQL, and what it deletes, with the row count. Applying it writes the schema and the migration as `migrate dev` does, and the local database reloads with them. Only the edited entries change in the file.
- The studio's routes answer only the studio's own page: requests from another origin or host name, and writes without a JSON body, are refused. The studio now writes files, so a page on another site must not reach it.

## 0.1.14 - 2026-11-17

- The studio no longer fills the `tapedb dev` log. It checked the workspace list every 2 seconds and the open workspace every 1.5 seconds, and wrangler logged each request. Both now wait for a change: `GET /engine/workspaces/:id/status?after=<seq>` answers when a transaction lands past `seq`, or after 25 seconds, and the local workspace list does the same with `?known=<count>`. An idle studio now adds one log line per 25 seconds, and writes show up sooner.
- The studio's empty screen offers "Create a workspace" in place of a code sample. The PLAY/STOP indicator is gone. The tape and the Models heading appear once a workspace is open.

## 0.1.13 - 2026-11-17

- The studio now uses the tapedb brand from tapedb.dev. It has the cassette mark, whose hubs turn while the studio is live, signal orange, and the Space Grotesk, Inter and JetBrains Mono fonts. The fonts ship in the package, so the studio works offline; they are licensed under the OFL (`assets/fonts/OFL.txt`). A PLAY/REC indicator shows the connection. A transaction tape along the bottom steps on with every write and names it (`task.create`). Rows that just arrived or changed are tagged NEW or CHANGED. True and false values show the landing page's check and ring glyphs. The studio is dark by default and follows the docs' light theme.

## 0.1.12 - 2026-11-17

- `npx tapedb-cli dev` works in a project that has been deployed. Deploying writes `"ENVIRONMENT": "production"` into `wrangler.jsonc`, and local dev read it too, so `http://localhost:8787/` answered `no_route` and the dev claim route refused every request. `dev` now always runs as `development`. Deploys still use `production`.

## 0.1.11 - 2026-11-17

- A new studio. Models are listed with their row counts, and rows show in a table with typed columns: dates are readable, and relations show the related row's name and open it. Rows can be sorted by any column and filtered by field. Clicking a row opens it in an editor, which has a field for each type, a picker for relations, the rows that point to it, and two-step deletion. Rows can be added from the studio. A counter shows the workspace's transaction count, and the table refreshes as writes land. The studio follows the system's light or dark mode and works on a phone.
- The schema endpoint (`GET /engine/workspaces/:id/schema`) also names the field that stores each link (`links[].foreignKey`).
- During `npx tapedb-cli dev` the studio opens the most recent local workspace by itself, without asking for an id. A workspace is listed as soon as the app opens it, and the list holds every workspace with local data. Without workspaces the studio says so and opens the first one when it appears. Deployed Workers have no such list, so the studio still asks for an id there.

## 0.1.10 - 2026-11-17

- `npx tapedb-cli dev` starts the studio with the database and prints both addresses. Opening the local Worker's address (`http://localhost:8787/`) goes to the studio instead of answering `no_route`. The redirect needs dev claims, a non-production environment and a loopback studio address, so a deployed Worker never has it.

## 0.1.9 - 2026-11-17

- New package `tapedb-cli`: run `npx tapedb-cli init`, `npx tapedb-cli dev` and `npx tapedb-cli deploy`, with no flags. `npx @tapedb/tapedb` inside a project ran the project's installed copy, which could be older; `tapedb-cli` isn't installed in the project, so `npx` fetches the newest one. It runs the `@tapedb/tapedb` release of the same version.
- `init`, `dev` and `deploy` bring the project's `@tapedb/tapedb` up to the CLI's version, whatever the dependency says (`^0.1.7` included), using the project's package manager, and say so (`updated  @tapedb/tapedb 0.1.7 → 0.1.9`). Newer versions, `workspace:` and `file:` links are left alone. Before, only an exact older pin was moved, and only by `init`.
- Messages and docs name `npx tapedb-cli` commands.

## 0.1.8 - 2026-11-17

- Running `init` again with a newer tapedb moves the project's `@tapedb/tapedb` to that version when the project pins an exact older one, which an earlier `init` wrote, and says so (`updated  @tapedb/tapedb 0.1.4 → 0.1.8`). Before, the project kept the old version, so `npx @tapedb/tapedb deploy` and the deployed Worker ran it. Ranges, tags, links and newer versions are left as they are.

## 0.1.7 - 2026-11-17

- Cloud setup no longer fails with "R2 bucket creation failed … already exists, and you own it" on an account with more than 20 R2 buckets. `wrangler r2 bucket list` shows only the first 20, so setup missed buckets it had created on an earlier run and created them again. It now creates each bucket and keeps one the account already owns (Cloudflare code 10004); a bucket owned by another account, or any other failure, still stops setup.

## 0.1.6 - 2026-11-16

- A first cloud deploy no longer stops at "Secret lookup failed". Wrangler 4.163 reports a Worker that doesn't exist yet as `Worker "<name>" not found.` without the API's 10007 code, which setup didn't recognise; it now treats that answer, for the Worker being deployed, as "no secrets yet" and generates them.
- Setup recognises existing R2 buckets, and a missing Worker, when Wrangler colours its output. A second run after a failed first deploy reuses the buckets it created.


## 0.1.5 - 2026-11-16

- Setup uses arrow-key menus with visible choices and cancellation. Choosing cloud setup proceeds to deployment without asking the same question again. Standalone deploy has one explicit Deploy now confirmation.


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

- `node scripts/e2e.mjs` runs the packed consumer's workerd scenarios and the
  migration, workspace-erasure and R2-recovery drills.
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
  answers 503 `workspace_recovering`.
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
