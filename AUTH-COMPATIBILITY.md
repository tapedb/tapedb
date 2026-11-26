# Better Auth compatibility

What tapedb's Better Auth adapter (`@tapedb/tapedb/auth`, `tapedbAuth()`)
supports, what it supports with a caveat, and what has not been checked. Every
"verified" row is a test that runs Better Auth's real endpoints in workerd
(Miniflare), with everything stored in the AuthRoom Durable Object:
`scripts/auth/plugins.vitest.ts` and `scripts/auth/runtime.vitest.ts`, both
part of `bun run test:auth`. Better Auth's own adapter conformance suites run
in `scripts/auth/adapter.vitest.ts`.

Checked against `better-auth` 1.7.25, `@better-auth/oauth-provider` 1.7.25 and
`@better-auth/passkey` 1.7.25.

## How the adapter is built, and what follows from it

- **One AuthRoom holds every user, session, account, verification value and
  plugin table.** Each adapter call is one RPC to that Durable Object and runs
  as one SQLite statement (or one `transactionSync` block) inside it. A
  Durable Object handles one call at a time, so each call is atomic on its own.
- **No multi-call transactions (`transaction: false`).** Better Auth's
  `runWithTransaction` hands an adapter a callback that may await anything, and
  an RPC boundary can't hold a SQLite transaction open across awaits. Better
  Auth supports this mode on purpose: writes inside such a block apply as they
  happen, and a failure part-way leaves the earlier writes in place.
- **The security-sensitive steps don't depend on transactions.** Better Auth
  1.7 does "use this once" and "count this attempt" through two adapter
  primitives, `consumeOne` (delete and return one matching row) and
  `incrementOne` (a conditional update). tapedb implements both as single
  statements in the AuthRoom (`DELETE … RETURNING`, `UPDATE … WHERE`). The
  tests race each of these steps with concurrent requests and require exactly
  one winner. With a deliberately non-atomic `consumeOne` (find, wait, delete)
  six of those tests fail, so they do detect a broken implementation.

## Matrix

| Capability | Status | What was checked |
| --- | --- | --- |
| Email and password sign-up, sign-in, sign-out | Verified | Sessions survive a runtime restart (`runtime.vitest.ts`) |
| Session listing and revocation | Verified | Revoking one session ends it; "revoke other sessions" keeps the current one |
| Session invalidation on ban | Verified | `admin/ban-user` ends the user's sessions and refuses their next sign-in |
| Magic link | Verified | Three concurrent redemptions of one link produce exactly one session |
| Two-factor: TOTP | Verified | Enrolment, verification, and the second-factor step at sign-in |
| Two-factor: backup codes | Verified | One code raced by three pending sign-ins succeeds exactly once (`incrementOne`) |
| Organization and roles | Verified, with a caveat | Create, invite, accept, change role; accepting an invitation twice doesn't add a second membership (the invitation moves out of `pending` in one conditional update). Removing a member, deleting an organization, team membership and the member row an accepted invitation creates are written inside `runWithTransaction`, so a failure part-way through one of them can leave its earlier writes in place |
| Admin plugin | Verified (ban) | Other admin routes untested |
| JWT and JWKS | Verified | The JWT from `get-session` carries a key id published at `/jwks` |
| OAuth 2.1 / OIDC provider: client registration | Verified, with a caveat | Dynamic registration (`/oauth2/register`). It writes inside `runWithTransaction`; a failure part-way can leave a client without its resource bindings |
| OAuth provider: authorization code with PKCE | Verified | Consent flow; a wrong `code_verifier` is refused; three concurrent redemptions of one code produce at most one token, and the others are refused with `invalid_grant` (a reused code revokes what it issued, so under a race the first redemption can be refused too) |
| OAuth provider: refresh token lifecycle | Verified | Three concurrent rotations of one refresh token produce exactly one; replaying a rotated token is refused and revokes the token it was rotated into |
| OAuth provider: token revocation | Verified | A revoked refresh token is refused |
| Device authorization (RFC 8628) | Verified | Code issue, claim and approval; three concurrent polls produce exactly one token |
| Passkeys / WebAuthn | Partly verified | Registration options are issued and their challenge stored. A full ceremony needs an authenticator, and the test has none. Registration with `createSession` writes inside `runWithTransaction` |
| Account linking (social providers) | Not verified | Needs an external OAuth provider; nothing in the adapter is specific to it |
| Concurrent authentication requests | Verified | Every race above runs against one AuthRoom |
| Atomic token consumption | Verified | `consumeOne` and `incrementOne` above |
| Better Auth adapter conformance | Verified | `normalTestSuite`, `caseInsensitiveTestSuite`, `uuidTestSuite`, `authFlowTestSuite` (`adapter.vitest.ts`) |

## Not supported, by design

- **Rollback of multi-step plugin writes.** Covered above. Where a plugin's
  flow must be all-or-nothing beyond what `consumeOne`/`incrementOne` give, it
  isn't, on this adapter.
- **An identity provider product.** tapedb stores Better Auth's data; it
  doesn't add identity features of its own. SAML, LDAP and enterprise
  federation come from Better Auth plugins or an external IdP, not from
  tapedb.
- **More than one AuthRoom.** Every auth table lives in one Durable Object
  (`idFromName("auth")`), so all sign-ins share one writer. For a deployment
  whose authentication traffic outgrows one object, use an external store
  for Better Auth.
