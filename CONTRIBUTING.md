# Contributing

TapeDB is small on purpose. The fastest way to get a change accepted is to keep
it inside one of the entry points and to prove it with a test that fails
without your change.

## Setup

```bash
bun install
bun run verify      # typecheck + test + build + packed-package checks
```

Run `bun run verify` before opening a pull request and list what you ran.

No Cloudflare account is needed for the test suite: the engine tests run against
in-memory SQLite, and the client tests use a fake socket and a fake fetch.

To try the product itself:

```bash
npx @tapedb/cli init     # writes a Worker, a schema, wrangler config and .dev.vars
npx @tapedb/cli dev      # local database, and the studio at http://localhost:8787/
```

## What goes where

| Path | Rule |
| --- | --- |
| `src/engine/` | Server side. No React, no DOM, no `fetch` to your own API. |
| `src/client/` | Framework-free client. **No React imports.** |
| `src/react/` | The only entry allowed to import React. |
| `src/cli/` | Node-only. No Cloudflare SDK imports. |
| `test/` | `bun test`. Engine tests use `bun:sqlite`; client tests use fakes. |

Two rules have already been broken once and cost a debugging session each, so
they are worth stating:

1. **The core has zero runtime dependencies.** If `bun run build` produces an
   `index.js` that mentions `react`, the build is wrong.
2. **Nothing in `src/` may reference the application this was extracted from.**
   No product names, no table names, no bucket names. `bun test` does not check
   this; review does.

## Packages and entry points

One rule decides whether something becomes a package, so `@tapedb/tapedb/xyz →
@tapedb/xyz` can never happen ad hoc:

> **A package is a distribution unit with its own dependency or peer graph.
> A subpath is an entry point of the core's own graph.
> Framework bindings and optional-peer integrations are always packages.**

Every package is a re-export of one core entry (`export * from
"@tapedb/tapedb/<entry>"`), never a fork; the CLI is the one package that runs
the core's bin instead. Each package carries the core version, pins
`"@tapedb/tapedb"` to that exact version, and publishes publicly.

| entry | form | notes |
| --- | --- | --- |
| core | `@tapedb/tapedb` | the product name; not renamed |
| CLI | `@tapedb/cli` (`packages/cli`) | bin stays `tapedb-cli`; core keeps its `tapedb` bin |
| React bindings | `@tapedb/react` (`packages/react`) | peer `react ^19`; `@tapedb/tapedb/react` stays as an alias indefinitely |
| Auth integration | `@tapedb/auth` (`packages/auth`) | optional peer `better-auth` |
| Email helper | `@tapedb/email` (`packages/email`) | |
| React Native | `@tapedb/react-native` | when the AsyncStorage outbox adapter exists — it carries real code, so it is not a thin alias |
| Vue / Svelte / Solid | `@tapedb/vue` etc. | only in the release where each wrapper lands; no placeholder packages |
| core entry points | `./schema`, `./worker`, `./studio`, `./seed`, `./react`, `./auth`, `./email` | same package, same dependency graph, no peer |

Adding a subpath to `src/` does not create a package, and adding a package does
not move the entry: the subpath stays supported. A new framework or integration
package means a new directory under `packages/` with the shape above, a case in
`scripts/package-smoke.mjs`, and a line in [RELEASING.md](RELEASING.md)'s
publish order — that is what keeps the two names one release.

## Tests

- A test that cannot fail is not a test. When you add a refusal, prove it fires:
  assert the error, and where practical show the allowed path still works.
- Prefer the real pipeline over mocks. `test/permissions.test.ts` runs the actual
  transaction pipeline against SQLite; mocking `runTransaction` would prove
  nothing about permissions.
- If your change touches the request path, add the live check you ran to the PR
  description instead of writing a test that starts a Worker.
- A double may simulate a failure the real world can produce: a full disk, a
  500, a socket that drops mid-frame. It may **not** be the only evidence that
  our code matches somebody else's interface. For a third-party contract, test
  against the artifact that ships — the vendor generally publishes one. A fake
  written beside the code carries that code's assumptions and can only confirm
  them: the React Native adapter passed every test against a hand-written fake
  while `clear()` silently left every entry on disk against the vendor's v3,
  whose mock renamed the method the adapter called.
- A feature that speaks a protocol — a socket frame, a webhook payload, a CLI's
  printed output — is not covered until a scenario in `scripts/e2e/` exercises
  it against workerd. Unit tests over hand-built frames check the code against
  a model of the protocol written by whoever wrote the code.

## Commits

- One slice per commit. The body explains what was wrong, not what you typed.
- Stage explicit paths. `git add -A` has swept unrelated files into commits in
  this repo's history.
- Do not push to `main`. Branches and pull requests.

## End to end

`bun run verify` runs on bun's SQLite, which allows far more than a Durable
Object's (32,766 bound parameters against 100, expression depth 1000 against
100). Anything that touches SQL or the socket is checked in workerd too:

```bash
node scripts/e2e.mjs                    # pack, fresh project, tapedb dev, every scenario + drills
node scripts/e2e.mjs --only select,bulk
TAPEDB_DEV_CLAIMS_TOKEN=<token> node scripts/e2e.mjs --url https://<staging worker>   # a deployed Worker with gated dev claims
```

It packs this checkout, installs the tarball and wrangler into an empty
project, runs `tapedb init` and `tapedb dev`, and runs each scenario in
`scripts/e2e/` as a consumer would. Locally it then runs the drills: seed past
a snapshot, let the durability alarm flush and snapshot, rebuild a referenced
table through a migration, wipe the Durable Object's storage, and check the
workspace comes back from R2 identical — every row, the file index, the
sequence, the idempotency receipts. About four minutes, most of it waiting for
the alarm.

## The soak

`bun test` runs a small recovery drill on every change. The long one is a
script, because it takes minutes:

```bash
bun scripts/soak.ts --generations 10 --ops 2000      # ~20k transactions
bun scripts/soak.ts --generations 5 --ops 1200 --seed 7
```

It runs generations of mixed traffic through the real pipeline, flushing and
snapshotting as it goes, then wipes the database and rebuilds it from R2 —
and carries the rebuilt database forward, so a restore has to survive being
restored again. Each generation checks every table row for row, the sequence
state, the file index, that a retry inside the horizon is still deduped, and
that a second forced recovery changes nothing. A failure prints the seed to
replay it.

It also prints timings. Two numbers are worth watching, because the design
depends on them: segment count must stay flat as history grows (pruning), and
recovery time must track row count rather than how long the workspace has
existed.

Run it before a release and after anything that touches the engine, the
flusher, snapshots or recovery.

## Releasing

Do not publish from a feature branch, and do not create a release tag before
every gate is met. The gates, checks and publish steps are in
[RELEASING.md](RELEASING.md).

The package smoke check in `verify` uses Node 22.18 or newer and npm. It
installs the built tarball into default npm, CommonJS and ESM projects, then
checks initialization, migration generation and failure handling. It never
publishes to npm or changes the consumer package type.

Before publishing, run the package the way a consumer gets it, not the way the
repo has it. Every bug found late in 0.1.0, including the CLI exiting silently
under `npx` and uploads refusing to run under `tapedb dev`, was invisible to
`bun test` and obvious within a minute of this:

```bash
bun run verify
bun pm pack --destination /tmp/pack          # the published artifact
cd $(mktemp -d) && npm init -y && npm i /tmp/pack/tapedb-*.tgz wrangler
npx @tapedb/cli init && npx @tapedb/cli dev          # then drive it with a script:
                                             # writes, a live subscription,
                                             # an upload, a migration
```

The package publishes as `@tapedb/tapedb`, under the `tapedb` npm org: npm
rejects the unscoped name as too similar to existing packages (`tape`,
`typedi`). Create the org in the web UI at `https://www.npmjs.com/org/create`;
there is no `npm org create` command. `repository`, `bugs` and `homepage`
already point at the GitHub repo and `https://tapedb.dev`.
