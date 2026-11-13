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
npx tapedb init     # writes a Worker, a schema, wrangler config and .dev.vars
npx tapedb dev      # local database with a dev claim route
npx tapedb studio   # table browser at http://127.0.0.1:4400
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

## Tests

- A test that cannot fail is not a test. When you add a refusal, prove it fires:
  assert the error, and where practical show the allowed path still works.
- Prefer the real pipeline over mocks. `test/permissions.test.ts` runs the actual
  transaction pipeline against SQLite; mocking `runTransaction` would prove
  nothing about permissions.
- If your change touches the request path, add the live check you ran to the PR
  description instead of writing a test that starts a Worker.

## Commits

- One slice per commit. The body explains what was wrong, not what you typed.
- Stage explicit paths. `git add -A` has swept unrelated files into commits in
  this repo's history.
- Do not push to `main`. Branches and pull requests.

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

The package smoke check in `verify` uses Node 22.18 or newer and npm. It
installs the built tarball into default npm, CommonJS and ESM projects, then
checks initialization, migration generation and failure handling. It never
publishes to npm or changes the consumer package type.

Before publishing, run the package the way a consumer gets it, not the way
the repo has it. Every bug found late in 0.1.0 — the CLI exiting silently
under `npx`, uploads refusing to run under `tapedb dev` — was invisible to
`bun test` and obvious within a minute of this:

```bash
bun run verify
bun pm pack --destination /tmp/pack          # the published artifact
cd $(mktemp -d) && npm init -y && npm i /tmp/pack/tapedb-*.tgz wrangler
npx tapedb init && npx tapedb dev            # then drive it with a script:
                                             # writes, a live subscription,
                                             # an upload, a migration
```

`tapedb` is unscoped and the name was free on npm as of 0.1.0, so no org is
needed:

```bash
npm login
npm publish --access public
```

Only a scoped release (`@tapedb/*`) needs an org, and orgs are created in the
web UI at `https://www.npmjs.com/org/create`. There is no `npm org create`
command.

`repository` and `bugs` already point at the GitHub repo. `homepage` stays out
until `tapedb.dev` actually serves something: a dead URL on the package page is
worse than no link.
