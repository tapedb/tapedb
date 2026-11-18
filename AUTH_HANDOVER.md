# Built-in auth handover — 18 November 2026

## Implemented for 0.1.30, based on current 0.1.29 main

1. Better Auth adapter and a dedicated app-wide SQLite AuthRoom. Official normal, case-insensitive, UUID and auth-flow suites pass. Native atomic token consumption and counters are implemented. The adapter does not advertise multi-operation asynchronous transactions.
2. Cloudflare send_email mailer. Local capture sends nothing and is available in the terminal and local Studio inbox. Production never serves the inbox.
3. `defineTapeDB({ auth })`, Better Auth routes, session-based subjects, stored workspace membership, explicit workspace creation, owner-only membership changes and last-owner protection.
4. `$users` relations. Member id/name/image copies go through the workspace's taped transaction path. Names/images are personal fields; includes and id-based relation filters work. A stale projection cannot restore an erased name.
5. Interactive init option and `--auth --email-from`. Auth scaffolding includes verification, reset, magic links, account erasure hooks, bindings and secret generation. Deployment onboards the sending domain and preserves existing secrets.
6. Studio Users page: sign-in, workspace creation, member roles, own sessions, sign-out and account erasure. Erasure requires transferring sole ownership and records durable retry jobs before erasing personal keys.

The packed auth scaffold is compiled as a downstream application, separately from the source typecheck. Runtime tests execute the generated auth.ts and test verification, password reset, one-use magic links, ownership, erasure, profile write protection and session persistence across a restart.

## Test-app rollout completed

The deployed test application now uses built-in auth. The legacy Access application and unconditional-owner identity adapter were removed after verification. Original schema migrations, database namespace, buckets and existing secrets were preserved; auth storage and the email binding were added. Email sending DNS is ready.

A passwordless owner account is provisioned. Its mailbox is verified only when the owner follows a normal sign-in link; no password was seeded. Real inbox delivery and a human-owned browser session were not exercised by the agent. Workerd tests cover verification, reset and magic links.

The live login page returns HTTP 200 without an Access redirect. Anonymous claims, workspace lists and member lists return 401; the production dev-email route returns 404. Temporary diagnostic Workers were removed. Ownership metadata was checked through authenticated private logs.

The recovered deployment source and infrastructure configuration are saved in a private deployment archive, rather than published in this repository. That archive is the canonical test-app source; the old standalone scaffold should not overwrite the migrated deployment. The missing Mac checkout did not prevent rollout.

The packages remain unpublished. Both packages still need publishing after this PR is merged. The public adoption integration fixture uses a synthetic account and in-memory resources; it contains no recovered deployment source or live account configuration.

## Files

- Adapter and storage: `src/auth/`
- Mailer and dev capture: `src/email/`
- Generated app auth: `src/cli/auth-template.ts`
- Auth runtime and official suites: `scripts/auth/`
- Studio Users: `src/studio/users-page.ts`
- Public contract: API.md and api/surface.json

## Validation

Run `bun install --frozen-lockfile` and `script -qec "bun run verify" /dev/null`. Verify includes the official adapter suites, real workerd tests, declaration builds and packed consumer checks. No GitHub Actions or public Workers Builds connection is used.
