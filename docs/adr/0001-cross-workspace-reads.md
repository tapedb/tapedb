# ADR 0001: Cross-workspace reads stay client-side, for now

Status: proposed (2026-11-26). Needs the owner's decision on the two follow-ups at the end.

## Context

`db.$across(ids)` reads several workspaces and merges the results in the
client. Each workspace is asked separately, with its own claim, and writes
and transactions stay inside one workspace. The question was whether that
holds up at 10, 100 and 1,000 workspaces, and whether the engine should
fan out on the server instead, or offer a separate read model.

## Measurements

`bun run bench:e2e` with `WORKSPACE_SCENARIOS=across ACROSS_COUNTS=10,100,1000
ACROSS_ROWS=2 ACROSS_READS=3`. The results are in
`bench/results/local-2026-11-26-across.json`. Local `tapedb dev` (one workerd
process) on Linux x64 with 2 CPUs and 8 GiB, with the client on the same
machine. The run includes one workspace whose token is refused, to check
partial failure.

| Workspaces | Rows | `findMany` p50 / max | `findPage` 50 p50 | `count` p50 | Client heap growth | One refused token |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 20 | 130 / 159 ms | 108 ms | 113 ms | not measurable | `AcrossError`, 18 rows in `partial`, 120 ms |
| 100 | 200 | 934 / 1,005 ms | 964 ms | 856 ms | not measurable | `AcrossError`, 198 rows in `partial`, 865 ms |
| 1,000 | 2,000 | 24.9 / 31.7 s | 20.7 s | 19.4 s | ~94 MB | `AcrossError`, 1,998 rows in `partial`, 20.7 s |

Seeding the 1,000 workspaces (their first write each) took 96 s.

What this shows, and what it doesn't:

- **Partial failure behaves correctly at every size.** One failed workspace
  rejects the read with `AcrossError`, names it, and keeps the other
  workspaces' rows in `partial`.
- **Cost grows faster than the workspace count.** 10× the workspaces cost
  about 7× from 10 to 100, and about 27× from 100 to 1,000. `$across` starts
  every workspace's request at once (`Promise.allSettled` over all of them),
  and each workspace client also fetches its own claim. At 1,000 that is
  about 2,000 concurrent requests from one client, plus about 94 MB of client
  heap for the per-workspace clients and results.
- **The absolute numbers are not Cloudflare's.** Here one local workerd
  process on 2 CPUs ran all 1,000 Durable Objects and the client. On
  Cloudflare each Durable Object runs on its own, so the server side would
  be far more parallel. But the client side wouldn't change: a browser opens
  a limited number of connections per host, and it would still mint 1,000
  claims. No deployed measurement was taken. `--deploy` / `--url` with the
  same variables takes it.

## Options considered

1. **Keep `$across` client-side (chosen).** It already preserves the
   authorization model (one claim per workspace, checked by that workspace)
   and the failure model (per-workspace errors, `partial`), and it works for
   live queries (one socket per workspace).
2. **Server-side fan-out: one request, the Worker asks N rooms.** It would
   replace N client round trips with one, but:
   - Authorization would have to change. One request would need to prove
     membership in N workspaces. With built-in auth the AuthRoom knows a
     user's workspaces. With a custom `identity`, tapedb has no such list, so
     the Worker would mint or verify N claims itself.
   - The Worker would hold every workspace's rows in its 128 MB isolate
     before merging, and make N subrequests per call. Paid plans allow
     10,000 subrequests per invocation by default. Workers also limit
     simultaneous outgoing connections per request (6); it hasn't been
     measured whether calls to Durable Object stubs count against that.
   - Live cross-workspace queries would need a server-side multiplexer. None
     exists.
   The evidence above doesn't justify that, because its cost is mostly a
   local-runtime artefact plus an unbounded client. Both are cheaper to fix
   first.
3. **A separate read model.** A projection, kept up to date by the existing
   webhooks into a store built for cross-tenant queries (D1, or a workspace
   of its own). It's the right tool for frequent reads across hundreds of
   workspaces, and it needs no engine change: it's an integration pattern.

## Decision

Keep `$across` as it is, and document its operating range: tens of
workspaces for interactive use, around 100 for occasional admin views, and a
read model beyond that. Don't build server-side fan-out without a deployed
measurement that shows the client-side cost remains after the follow-ups
below.

## Follow-ups that need the owner's approval

- **A concurrency bound in `$across`** (for example
  `$across(ids, { concurrency: 16 })`, with a default), so 1,000 workspaces
  don't mean 2,000 simultaneous requests and claim mints. It's a small,
  additive client change, and it can be measured with the same benchmark.
- **A deployed run** of the same benchmark (`--deploy`) at 100 and 1,000
  workspaces, to replace the local numbers above.
