# Security policy

## Supported versions

TapeDB has no public release yet. The private preview is tested from `main`;
there are no supported release branches or versions until the first public
release. Security fixes land on `main` and are called out in the changelog.

## Reporting a vulnerability

Do not open a public issue for a security report.

Use GitHub's private vulnerability reporting for this repository when it is
enabled:

<https://github.com/tapedb/tapedb/security/advisories/new>

Until the repository is public, private reporting may be unavailable; in that
case contact a repository maintainer directly through GitHub. Do not open a
public issue. Please include the affected commit or version, the trust boundary
you crossed, a minimal reproduction, and any suggested fix. Do not include real
claim tokens, Cloudflare secrets, customer data or personal data; use synthetic
values.

Maintainers will triage the report, confirm the affected path, and coordinate a
fix and disclosure. There is no bug bounty.

## Security model

- **Claims.** The Worker verifies a short-lived compact HS256 JWT before it
  touches a Durable Object. `TAPEDB_CLAIM_SECRET` is the shared signing secret.
  The optional issuer and audience checks are enforced only when configured.
  The development claim route is enabled only when the code opts in, the
  deployment sets `TAPEDB_DEV_CLAIMS=true`, and `ENVIRONMENT` is not
  `production`; `tapedb deploy` refuses to ship the flag.
- **Identity seam.** The engine never issues sessions. A deployment implements
  `getSubject` and `getRole`; the role it returns is signed into the claim.
- **Workspace isolation.** The Worker verifies the claim against the workspace
  id in the URL, then forwards a trusted, unsigned claim header to that
  workspace's Durable Object. Client-supplied `x-tapedb-*` headers are removed
  before forwarding. The Durable Object binding is not a public route.
- **Read and write rules.** `role()`, `filter()` and `check()` are applied in
  the engine. A rule that throws denies. Erasing a workspace requires an owner
  claim.
- **Files.** Uploads go to the workspace's R2 prefix. Without file rules,
  reads require at least member, writes and deletes at least editor. With
  rules (`schema(models, { files })`), the workspace's Durable Object decides
  every read, write, delete and multipart start or completion before bytes
  move, and lists only readable files; a file the caller may not read answers
  404. Rules fail closed. One request carries at most 25 MiB; larger files
  are R2 multipart uploads on the same route and role, tied to their file
  path, and listed only once complete.
- **Transport.** HTTP uses `Authorization: Bearer`; WebSocket upgrades carry the
  claim in `Sec-WebSocket-Protocol`, never in the URL. Claims should be kept out
  of request-header logging.

Data reaches Cloudflare over TLS and is encrypted at rest by Cloudflare. The
application owner is the data controller and Cloudflare is the processor; see
[PRIVACY.md](PRIVACY.md).

## Operator responsibilities

The library cannot enforce these for you:

- Keep `TAPEDB_CLAIM_SECRET` out of source control, logs and client bundles.
  Rotate it if it is exposed; all existing claims become invalid.
- Implement `getSubject` and `getRole` correctly. A role returned by
  `getRole` is trusted by the engine.
- Do not set `TAPEDB_DEV_CLAIMS` in production. On a deployed test Worker
  that untrusted users can reach, set it only together with a random
  `TAPEDB_DEV_CLAIMS_TOKEN` secret: the dev claim route then mints only for
  requests carrying that token in `x-tapedb-dev-token`, and answers 401
  otherwise. Set the token before turning dev claims on. `tapedb deploy`
  refuses `TAPEDB_DEV_CLAIMS`, but a manual `wrangler deploy` can still ship it.
- The claim route is rate-limited by default (per IP before the session
  lookup, per subject after it; exact, global token buckets in Durable
  Objects). Keep the limits on for a public route, and protect session-bearing
  identity lookups against CSRF according to your auth system. An unreachable
  limiter lets claims through and logs `claim_limit_unavailable`.
- Exclude the `Authorization` and `Sec-WebSocket-Protocol` headers from
  Cloudflare request-header logging.
- Do not add R2 bucket lock rules to the data or files buckets; they prevent
  retention and erasure.
- Account for Cloudflare's 30-day Durable Object point-in-time recovery when
  making erasure promises.

## Known limitations

The design boundaries and release gates are listed in
[LIMITATIONS.md](LIMITATIONS.md). In particular, TapeDB does not record who
made each write and its erasure cannot reach
Cloudflare's point-in-time recovery window.
