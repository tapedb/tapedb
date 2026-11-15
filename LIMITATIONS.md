# Known limitations

The boundaries TapeDB has by design, and the gates before a public release.

## Product boundaries

- **Cloudflare only.** TapeDB is a library for Workers, Durable Objects and R2.
  It has no hosted control plane; you deploy and operate it in your own account.
- **One writer per workspace.** Each workspace is one Durable Object. There is
  no cross-workspace query, join or transaction, and no active-active setup.
- **Identity is yours.** The engine verifies short-lived claims but does not
  manage users, sessions, passwords or memberships, and it does not record who
  made each write.
- **Personal fields use erasable keys.** Deleting a subject key makes its
  ciphertext unreadable in SQL, logs, snapshots and recovery copies. Ordinary
  plaintext and copies from before encryption follow the history retention
  and Cloudflare's 30-day recovery window.
- **Migrations are forward operations.** Destructive changes need
  `--accept-data-loss`; renames need an explicit rename; new required fields
  need a default or must be optional. Review generated SQL before deploying.


## Release gates

The repository and npm package remain private until all of these are true:

- CI runs the frozen install, typecheck, test suite, build, package smoke and
  secret scan on Node 22.18 or newer on every pull request and on `main`.
- Branch protection or rulesets are enabled. GitHub requires a paid plan for
  those on a private repository; on the free plan they must be enabled when the
  repository becomes public.
- A secret and history scan is clean, and dependency and GitHub Actions
  updates are reviewed.
- The security model in [SECURITY.md](SECURITY.md) has been reviewed against
  the claim, workspace, file and erase paths.
- A consumer can install the packed artifact in a clean project and exercise
  writes, live queries, uploads, migrations and erasure from the packaged CLI.
- An independent review has been completed, or the remaining risk has been
  accepted in writing by the maintainer.
- The project has been dogfooded beyond the test suite and staging drills, and
  the release notes state the known limitations above.

Independent audit and sustained production dogfooding cannot be resolved by a
code change in this repository. They remain release gates rather than items
that CI can prove.
