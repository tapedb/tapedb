# Benchmarks

Two suites, reported apart because they measure different things and only one
of them says anything about what a deployment serves.

| | what it runs | what it measures |
| --- | --- | --- |
| `bun run bench` (`scripts/bench.ts`) | the real engine — `runTransaction`, `executeQuery`, the flusher, the snapshotter, recovery — over bun's SQLite, in process, with R2 in memory | the engine's own cost, and how it scales with the data |
| `node scripts/e2e.mjs --only load` (`scripts/e2e/load.mjs`) | a packed build in workerd, or a deployed Worker, driven by real clients over real sockets | what a Worker and a Durable Object actually serve |
| `bun run bench:e2e` (`scripts/bench/*.mjs`) | the same, widened: writes, reads, realtime fan-out, durability lag and many workspaces | what a client waits for, and where it starts to climb |

**The local suite cannot tell you what a deployment can take.** bun's SQLite
allows 32,766 bound parameters against a Durable Object's 100 and an expression
depth of 1,000 against 100; there is no network, R2 is a `Map`, and nothing
pays for the Workers runtime, the socket, hibernation or a cold start. Its
numbers bound the engine's cost and show its shape as data grows. That is all.

No suite asserts a threshold. A benchmark that failed a target invented here
would be measuring the machine it ran on.

```bash
bun run bench                                    # defaults: 20,000 rows, 200 iterations
bun run bench --rows 50000 --iterations 500
bun run bench --only queries,durability --json bench.json
bun run soak                                     # the durability drill; see CONTRIBUTING.md

BENCH_JSON=load.json SUBSCRIBERS=50 WRITES=400 CONCURRENCY=8 \
  node scripts/e2e.mjs --only load               # the deployed-runtime half
```

Both write machine-readable JSON carrying the environment, the workload and
the results, so a run can be compared with a later one rather than read off a
terminal once. Every quantile in these suites is exact, computed from kept
samples — unlike `GET /metrics`, whose quantiles are bucket estimates by
design (see [API.md](API.md#metrics)).

## A recorded local run

tapedb 0.3.6 (`7504b12`), bun 1.4.4, Intel Xeon @ 2.10GHz ×2, Linux x64,
20,000 tasks / 40 boards / 400 columns, 200 iterations per measurement.
**These are engine costs in process, not a deployment's.**

### Writes

| scenario | p50 | p95 | p99 | throughput |
| --- | --- | --- | --- | --- |
| insert, 1 row per transaction | 0.022 ms | 0.048 ms | 0.066 ms | |
| insert, 10 rows per transaction | 0.139 ms | 0.277 ms | 1.279 ms | 56,571 rows/s |
| insert, 100 rows per transaction | 1.026 ms | 1.637 ms | 1.695 ms | 86,538 rows/s |
| insert, 1000 rows per transaction | 10.723 ms | 15.811 ms | 15.811 ms | 84,813 rows/s |
| update, 1 row per transaction | 0.025 ms | 0.061 ms | 0.094 ms | |
| `patchMany` over an indexed filter | 64.292 ms | 92.386 ms | 100.862 ms | |
| replayed `clientTxId` (deduped) | 0.009 ms | 0.016 ms | 0.033 ms | |

Batching is worth roughly 1.5 orders of magnitude: 100 rows in one transaction
cost about as much per row as 1,000 do, and both beat one-row transactions by
a wide margin. The receipt path is almost free, which is what makes an
aggressive client retry cheap.

### Queries

| scenario | p50 | p95 | p99 |
| --- | --- | --- | --- |
| `findUnique` by id | 0.027 ms | 0.068 ms | 0.135 ms |
| `findMany`, limit 50, no filter | 0.176 ms | 0.302 ms | 0.795 ms |
| filter on an **indexed** field | 0.178 ms | 0.295 ms | 0.903 ms |
| filter on an **unindexed** field | 1.236 ms | 1.393 ms | 1.546 ms |
| order by an indexed field, limit 50 | 0.145 ms | 0.222 ms | 0.735 ms |
| `include` one level | 0.119 ms | 0.204 ms | 0.844 ms |
| `include` two levels | 0.835 ms | 1.492 ms | 3.668 ms |
| relation filter, one link | 0.265 ms | 0.627 ms | 1.876 ms |
| relation filter, two links | 0.242 ms | 0.397 ms | 0.731 ms |
| `count`, whole model | 0.016 ms | 0.046 ms | 0.079 ms |
| aggregate sum/avg/min over an indexed filter | 3.289 ms | 3.776 ms | 4.429 ms |
| aggregate grouped by an indexed field | 4.166 ms | 6.691 ms | 6.903 ms |
| paginate by cursor, 50 per page | 0.333 ms | 0.433 ms | 1.179 ms |
| named SQL query (CTE + left join) | 9.212 ms | 13.627 ms | 14.375 ms |

Cursor pagination does not degrade with depth: the cost is a page, not an
offset. A relation filter costs about the same as an ordinary indexed filter,
because it compiles to a correlated subquery rather than fetching the linked
rows — and the second link adds almost nothing.

### Realtime (invalidation only)

| scenario | p50 | p95 | p99 |
| --- | --- | --- | --- |
| re-run 1 live query after a write | 0.178 ms | 0.391 ms | 0.658 ms |
| re-run 10 live queries after a write | 1.985 ms | 2.943 ms | 3.719 ms |
| re-run 100 live queries after a write | 18.166 ms | 21.049 ms | 22.086 ms |

This is the recompute, not the delivery: the socket, the diff and the wire are
in the load suite. The cost is linear in the number of live queries a write
touches.

### Durability

| scenario | time |
| --- | --- |
| flush 100 pending transactions | 3.2 ms |
| flush 1,000 pending transactions | 3.892 ms |
| flush 10,000 pending transactions | 36.822 ms |
| snapshot a 1,000-row workspace | 11.455 ms |
| snapshot a 10,000-row workspace | 61.059 ms |
| recover 1,000 rows from a snapshot | 25.558 ms |
| recover 10,000 rows from a snapshot | 87.942 ms |
| recover 1,000 rows by replaying the log | 19.021 ms |
| recover 10,000 rows by replaying the log | 126.471 ms |

R2 is in memory here, so these are the engine's serialization and replay costs
with none of R2's latency. Recovery tracks row count rather than how long the
workspace has existed, which is the property the design depends on — the soak
checks it holds as history grows.

### Storage

| workspace | on disk | per row |
| --- | --- | --- |
| 1,000 rows | 0.36 MiB | 381 bytes |
| 10,000 rows | 2.38 MiB | 249 bytes |
| 20,000 rows | 4.7 MiB | 246 bytes |

Including the transaction log and the engine's own tables. Per-row cost falls
as the workspace grows because the fixed overhead is amortised.

## A recorded deployed-runtime run

The same build packed and installed into a clean project, running under
workerd via `tapedb dev`, driven by 25 separate clients over 25 sockets:
25 subscribers each holding a 500-row ordered window, 200 writes at
concurrency 8.

| | |
| --- | --- |
| subscribers ready | 352 ms for 25 sockets, each with its first window |
| write throughput | 71 writes/s at concurrency 8 |
| write latency | p50 **107 ms**, p95 171 ms, p99 183 ms |
| fan-out delay (write → all 25 subscribers hold it) | p50 **154 ms**, p95 195 ms, max 213 ms |
| writes seen by every subscriber | 200/200 |

**This is the number that matters, and the comparison is the point.** The
engine inserts a row in 0.022 ms. The same write observed by a client takes
107 ms. The engine is a rounding error in that figure: the rest is the Workers
runtime, the socket, the trip through the room, and re-running 25 live queries
before the next request is served.

Two caveats, both load-bearing:

- This ran under workerd on a shared two-core machine. It is a **floor, not a
  ceiling** — a deployed Worker on Cloudflare's own hardware is a different
  measurement, and `--url <worker>` is how you take it.
- 25 live queries over the same model means every write pays the invalidation
  cost for all of them. That is the first bottleneck below, visible end to
  end.

## A recorded end-to-end run (`bun run bench:e2e`)

`bun run bench:e2e` (`scripts/e2e.mjs --suite bench`, workloads in
`scripts/bench/`) is the load scenario widened into a suite. It installs the
same packed build into a clean project and runs five workloads as separate
client processes over HTTP and real sockets, against `tapedb dev` or, with
`--url` / `--deploy`, a deployed Worker. Every measurement is written to one
JSON file along with the version, commit, target and runner, and
`node scripts/bench-report.mjs <file>…` prints tables from it. Sizes come from
environment variables (`WRITE_CONCURRENCY`, `QUERY_ROWS`, `SUBSCRIBERS`,
`ACROSS_COUNTS`, …; see each workload's header), and `SCALE` multiplies them
all.

| Workload | What it measures |
| --- | --- |
| `writes` | Sequential and concurrent (1/4/16) writes, 1/10/100 rows per transaction, a contended row, bursts, and a sustained load measured in 5 s windows |
| `queries` | Eleven read shapes through the client at 1,000 and 10,000 rows |
| `realtime` | Delay from a write until every subscriber has it, at 10/50/200 subscribers; several subscriptions per client; presence and broadcast fan-out; connect to first data |
| `durability` | How far R2 trails commits under sustained load, and how long after the last write it catches up, read from `GET /metrics` |
| `workspaces` | A new workspace's first write; the same writes spread over 1/8/32 workspaces; `$across` over 10 and 100 workspaces, including a refused token |

Recorded in `bench/results/local-2026-11-25.json`: tapedb 0.3.6 at `04b9db1`,
workerd via `tapedb dev`, Linux arm64, 4 CPUs, 4 GiB, Node 22.23.5. The client
processes shared those CPUs with the Worker. The `durability` workload in this
run read the durability state from an earlier diagnostics route that has since
been folded into `/metrics`; the numbers mean the same thing. Like the load run
above, **this is a floor and a shape, not a deployment's capacity.**

### Writes

| scenario | tx/s | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| 1 row, sequential | 104.7 | 8.7 ms | 15 ms | 22.8 ms |
| 1 row, concurrency 4 | 168.9 | 21.9 ms | 36.7 ms | 50.5 ms |
| 1 row, concurrency 16 | 202.7 | 81.3 ms | 118.6 ms | 127 ms |
| 10 rows, concurrency 1 | 78.9 (789 rows/s) | 10.5 ms | 20.1 ms | 35.1 ms |
| 100 rows, concurrency 1 | 28.4 (2,840 rows/s) | 32.7 ms | 52.2 ms | 63.2 ms |
| 100 rows, concurrency 16 | 25.2 (2,520 rows/s) | 614.9 ms | 746.5 ms | 748.7 ms |
| one row updated, concurrency 16 | 116.9 | 111.3 ms | 279.4 ms | 665.5 ms |
| 5 bursts of 80 at once | – | 501 ms | 685.3 ms | 686.7 ms |
| sustained, concurrency 8, 20 s | 125.6 | 56.4 ms | 124.4 ms | 215.3 ms |

The sustained run's p95 per 5 s window was 122, 100, 117, 149 and 61 ms: no
drift.

### Reads through the client

| scenario | 1,000 rows p50 / p95 | 10,000 rows p50 / p95 |
| --- | --- | --- |
| id lookup | 34.6 / 48.1 ms | 27.2 / 36.9 ms |
| indexed filter | 33.7 / 39.1 ms | 27.9 / 36.8 ms |
| unindexed filter | 33.5 / 41.4 ms | 27 / 34.1 ms |
| include a column's tasks (~50 / ~500) | 30.3 / 35.5 ms | 49.6 / 83.2 ms (p99 271 ms) |
| relation filter, take 100 | 31 / 40.1 ms | 37.8 / 51.5 ms |
| page of 50 | 34.4 / 42.3 ms | 33.4 / 44.7 ms |
| aggregate | 31.8 / 43.4 ms | 33.8 / 100 ms |
| named SQL | 31.7 / 46.3 ms | 41.2 / 65.7 ms |
| every row | 43.2 / 60.7 ms | 272.9 / 324.4 ms |

Through a client, the engine's 7× gap between indexed and unindexed filters
(above) disappears into the round trip at these sizes. What grows is what
returns more data.

### Realtime

| scenario | write → every subscriber p50 / p95 / p99 |
| --- | --- |
| 10 subscribers | 51 / 88.4 / 229.7 ms |
| 50 subscribers | 47.4 / 80.2 / 95.1 ms |
| 200 subscribers (ready in 1.2 s) | 62.1 / 105.7 / 112.1 ms |
| 10 clients × 5 subscriptions | 52.1 / 79.3 / 127.1 ms |

| fan-out to every peer, p50 / p95 / p99 | 10 peers | 50 peers | 200 peers |
| --- | --- | --- | --- |
| presence update | 1.5 / 3.3 / 5 ms | 4.4 / 11.6 / 35.2 ms | 60.3 / 134.8 / 162.1 ms |
| broadcast message | 4.3 / 6.9 / 14.3 ms | 6.5 / 26.6 / 35.1 ms | 14.7 / 27.4 / 52.9 ms |

### Durability and many workspaces

| scenario | result |
| --- | --- |
| 2,000 writes at concurrency 8 | 116 tx/s; at most 1,991 committed writes not yet in R2; R2 caught up 13.8 s after the last write; no flush failures |
| first write to a new workspace (50) | 771 / 964 ms p50 / p95; the second write 57 / 66 ms |
| 400 writes over 1 / 8 / 32 workspaces | 160 / 145 / 103 tx/s, all on one 4-CPU machine |
| `$across` findMany, 10 workspaces × 20 rows | 161 ms p50, 602 ms p95 |
| `$across` findMany, 100 workspaces × 20 rows | 515 ms p50, 1,032 ms p95 |
| `$across` with one token refused | `AcrossError` naming that workspace, other rows in `partial` |

## Bottlenecks

Eight. The first four come from the engine suite, the rest from the end-to-end one.

1. **Live queries are a per-write tax, and the writer pays it.** A Durable
   Object is single-threaded, so re-running live queries happens between a
   write committing and the next request being served. At 100 live queries
   touching one model that is roughly 18 ms added to every write to it.
   Fewer, narrower subscriptions cost less than many broad ones; a filter that
   excludes a model keeps writes to it off the path entirely.

2. **`patchMany` is the most expensive write by an order of magnitude.** 64 ms
   at p50 against 20,000 rows, because the engine resolves the match set
   inside the transaction and writes up to 1,000 rows from it. It is the right
   shape for correctness — the log records the rows, not the filter, so a
   replay changes what the original changed — but it is not a cheap call.
   Narrow the filter, and do not put one on a request path that needs to be
   fast.

3. **An unindexed filter costs about 7× an indexed one at 20,000 rows, and the
   gap grows with the table.** `.index()` on fields you filter by is the
   single highest-value schema change. Nothing currently tells you which
   filters are missing an index; that is what Workstream D is for.

4. **A named SQL query is the most expensive read.** 9 ms for a CTE and a left
   join over 20,000 rows. That is the cost of the expressiveness, and it is
   fine for a report; it is not a per-keystroke query.

5. **Presence fan-out grows with the square of the room.** Every presence
   update sends the whole peer list to every peer. At 200 peers that took
   60 ms p50 and 162 ms p99, against 15 ms and 53 ms for a broadcast of the
   same size to the same peers.

6. **One workspace's writer saturates early.** Past about 4 concurrent
   writers a workspace adds latency rather than throughput: 169 tx/s at 4,
   203 at 16, with p50 going from 22 to 81 ms. A 100-row transaction queued
   behind 15 others waited 615 ms.

7. **R2 trails commits by up to the alarm delay.** The durability alarm runs
   30 s after a write (`DURABILITY_ALARM_DELAY_MS`) so several writes go into
   one segment. During that time a committed write is durable in the Durable
   Object's storage, but recovery after losing that storage starts from R2.
   `/metrics` reports the gap (`pendingSeq`, `oldestPendingAt`) and calls it
   `flush_lagging` past 5 minutes.

8. **A workspace's first request is expensive, and `$across` pays per
   workspace.** The first write took about 770 ms against 57 ms for the next,
   because it creates the object, runs migrations and checks R2 for a
   restore. `$across` makes one request with one claim per workspace and
   merges in the client: about 515 ms p50 at 100 workspaces.

## Operating guidelines

These follow from the measurements above, not from a target.

- **Batch writes.** One transaction of 100 is worth about 50 of one. The
  client's `$transaction` already does this; use it for bulk work.
- **Index what you filter by**, and prefer `filter()` read rules to `check()`:
  a `filter()` compiles into SQL, while a `check()` runs after fetch and is
  scan-capped (see [LIMITATIONS.md](LIMITATIONS.md)).
- **Page with cursors, not offsets.** Cursor cost is flat with depth.
- **Keep subscriptions narrow.** The per-write cost is linear in how many live
  queries a write touches.
- **Watch `pendingSeq`** from `GET /metrics`: it should fall back toward zero
  between alarms. Growing across several reads means durability is behind.
- **Keep presence rooms small**, or use broadcast for frequent signals to
  large rooms.
- **Expect up to about 30 s between a commit and its R2 copy**, and alert on
  `flush_lagging` / `flush_failing` from `/metrics`.
- **Warm workspaces created ahead of use** with one request, if their first
  request is latency-sensitive.
- **Use `$across` for tens of workspaces.** For hundreds, a read model (a
  projection kept by webhooks, for instance) is the better fit.
- **One workspace is one writer.** Partition by whatever your transactions
  actually span — a workspace is the unit of serializability, so a workload
  that needs more write throughput than one object gives needs more
  workspaces, not a bigger one.

## What is not measured here

- **Cloudflare cost.** Request, duration and storage pricing changes, and
  anything computed here would be a guess presented as a figure.
- **Memory.** Neither suite reports a Durable Object's memory; the runtime
  does not expose a figure worth recording.
- **A Durable Object's SQL limits.** The local suite runs on bun's SQLite,
  which is far more permissive. `scripts/e2e.mjs` is where SQL and socket
  behaviour is checked against workerd's real limits.
- **`$across` on Cloudflare at 1,000 workspaces.** A local run at 10, 100 and
  1,000 (`WORKSPACE_SCENARIOS=across ACROSS_COUNTS=10,100,1000`) is in
  `bench/results/local-2026-11-26-across.json`. It is discussed in
  [docs/adr/0001-cross-workspace-reads.md](docs/adr/0001-cross-workspace-reads.md):
  about 0.9 s at 100 workspaces and 20–25 s at 1,000, with one local workerd
  running every object. A deployed run is still to be taken.
- **R2 failing mid-run.** A client cannot cause it; the room tests cover it,
  and the staging drills cover a lost Durable Object.
- **Cloudflare's own hardware.** The deployed-runtime run above is workerd on
  a shared machine. Take the real figure with
  `node scripts/e2e.mjs --url https://<worker> --only load`.
