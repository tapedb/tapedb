# ADR 0001: Cross-workspace reads stay client-side, for now

Status: accepted (2026-11-26).

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

### Deployed run (2026-11-26)

Staging build `fed55443`, from a throwaway branch with the `concurrency`
option (#114) and an `across-scale` scenario. The Worker ran on Cloudflare
(`staging.tapedb.dev`) and the client in the Workers Builds container, with 2
rows per workspace and three `findMany` reads at each setting. Every read
returned every row.

| Workspaces | Seeding | concurrency 16 | 64 | unbounded |
| --- | --- | --- | --- | --- |
| 100 | 3.1 s | 331 ms p50 (316–357) | 261 ms (246–395) | 228 ms (192–277) |
| 1,000 | 18.6 s | 11.2 s p50 (4.1–11.7) | 3.9 s (3.8–3.9) | 4.0 s (3.8–8.7) |

On Cloudflare each workspace's object runs on its own, so the server side
is parallel and the local bottleneck is gone: 1,000 workspaces read in
about 4 s, not 25. A bound of 16 makes the client wait in line (11 s). A
bound of 64 reads as fast as unbounded and still caps what the client holds
open, so it is the default in #114. The first unbounded read (8.7 s)
includes minting 1,000 claims at once.

The client here was a Node process in a build container. A browser on
HTTP/1.1 opens few connections per host and would sit closer to the
bounded numbers. This run did not measure that.

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

Keep `$across` client-side, with a bound on concurrency (default 64, #114).
Its operating range, measured on Cloudflare: around 100 workspaces in a
quarter to a third of a second, which is fine for interactive use; 1,000 in
about 4 s, which is fine for an admin view or a report but not for an
interactive screen. Beyond that, use a read model. Don't build server-side fan-out without a deployed
measurement that shows the client-side cost remains after the follow-ups
below.

## Follow-ups

Both were approved and done on 2026-11-26: the concurrency bound (#114,
default 64) and the deployed run above. Still open: the same measurement from
a browser.
