# Design and release gates

## Design

- **Cloudflare only.** TapeDB is a library for Workers, Durable Objects and R2.
  It has no hosted control plane; you deploy and operate it in your own account.
- **One writer per workspace.** Each workspace is one Durable Object, so
  transactions are serializable without locks. A transaction or join stays in
  one workspace, and there is no active-active setup. Reads span workspaces
  with `db.$across`.
- **Identity is yours.** TapeDB verifies short-lived claims and works with the
  auth you already have, as an ORM does; it does not manage users, sessions,
  passwords or memberships.
- **Personal fields use erasable keys.** Deleting a subject key makes its
  ciphertext unreadable in SQL, logs, snapshots and recovery copies. Ordinary
  plaintext and copies from before encryption follow the history retention
  and Cloudflare's 30-day recovery window.
- **Migrations are files you review.** Destructive changes need
  `--accept-data-loss`; renames need an explicit rename; new required fields
  need a default or must be optional. `migrate rollback` writes the migration
  back to an earlier schema; a drop cannot be undone, because its values are
  gone. Review generated SQL before deploying.

## Release gates

The repository and npm package stay private until every gate in
[RELEASING.md](RELEASING.md) is met: CI on every change, a clean secret and
history scan, a security review of the claim, workspace, file and erase paths,
a packed artifact exercised from a clean project, an independent review or
the maintainer's written acceptance of the remaining risk, and dogfooding
beyond the test suite and staging drills.
