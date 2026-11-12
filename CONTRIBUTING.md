# Contributing

TapeDB is small on purpose. The fastest way to get a change accepted is to keep
it inside one of the entry points and to prove it with a test that fails
without your change.

## Setup

```bash
bun install
bun run verify      # typecheck + test + build, the same thing CI runs
```

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

## Releasing

`tapedb` is unscoped, so no npm org is needed:

```bash
bun run verify
npm login
npm publish --access public
```

Only a scoped release (`@tapedb/*`) needs an org, and orgs are created in the
web UI at `https://www.npmjs.com/org/create`. There is no `npm org create`
command.

After the first publish, add `repository` and `bugs` to `package.json`: they are
deliberately absent until the public URL exists.
