# Releasing TapeDB

## Current status

0.1.0 is the first release. Every later release passes the same gates and
checks before it is tagged or published.

The design boundaries are in [LIMITATIONS.md](LIMITATIONS.md). The security
model and operator responsibilities are in [SECURITY.md](SECURITY.md).

## Gates

All gates must be true before a release is tagged or published:

1. `bun install --frozen-lockfile && bun run verify` passes on Node 22.18 or
   newer.
2. The secret and history scan is clean, and dependency updates have been
   reviewed.
3. The security review covers claims, the trusted claim header, workspace
   isolation, file routes and erasure. Findings are fixed or accepted in
   writing.
4. A clean consumer project installs the packed artifact and exercises writes,
   live queries, an upload, a migration and erasure through the packaged CLI.
5. The changelog and README describe the release and its design boundaries.
6. Independent source review is complete, and the release candidate passes
   deployed-runtime durability, recovery, migration, erasure and offline
   persistence checks.
7. The GitHub repository is made public only after the npm package is ready,
   with branch protection or rulesets and secret scanning enabled. GitHub does
   not offer branch protection or rulesets for private repositories on the
   free plan, so this is applied at the visibility change; until then the
   checks are advisory.

The scoped security review is recorded in
[SECURITY-REVIEW.md](SECURITY-REVIEW.md). The independent source review and
remediation are recorded in [INDEPENDENT-REVIEW.md](INDEPENDENT-REVIEW.md).
Check the validation results against the exact release candidate commit.

## Package checks

Run these before a tag, from a clean checkout:

```bash
bun install --frozen-lockfile
bun run verify
bun run test:e2e
bunx playwright install --with-deps chromium
bun run test:browser
bun pm pack --destination /tmp/pack
```

The consumer check is `bun run test:e2e`: it exercises a freshly packed
artifact in workerd, including writes, live queries, files, migrations, owner
erasure and an R2 restore. `bun run test:browser` checks IndexedDB persistence
across a reload in Chromium.

The secret and history scan that a workflow used to run is `gitleaks detect`:

```bash
gitleaks detect --source . --redact --no-banner --verbose   # gitleaks v8.30.1
```

The package smoke test inside `verify` installs the tarball under Node in
default npm, CommonJS and ESM projects. It uses Node 22.18 or newer and npm, and emits consumer TypeScript declarations.
It then packs every package under `packages/` — `@tapedb/cli`, `@tapedb/react`,
`@tapedb/auth` and `@tapedb/email` — and installs each one beside the packed
core tarball, never from the registry. Each case requires the package to carry
the core version and pin it exactly, to ship only its declared files, and to
hand back the subpath's own bindings (for the CLI, to run the core's own CLI
with its exit codes), so a wrapper left behind by a release fails the gate.

Exercise the packed product as a consumer would:

```bash
cd "$(mktemp -d)"
npm init -y
npm install /tmp/pack/tapedb-tapedb-*.tgz /tmp/pack/tapedb-cli-*.tgz wrangler
npx @tapedb/cli init
npx @tapedb/cli dev
```

Drive that project through a write, a live subscription, an upload, a
migration and erasure. Do not release on the strength of the unit suite alone.

## Publishing

Only after the gates and checks:

1. Update `CHANGELOG.md` and set the intended version in `package.json`, and
   the same version in `packages/cli/package.json`, `packages/react/package.json`,
   `packages/auth/package.json` and `packages/email/package.json` (each one's
   `version` and its `@tapedb/tapedb` dependency). All five move in lockstep:
   the four packages pin the core version exactly.
2. Open the release pull request and remove `"private": true` there. Keep
   `publishConfig` and the repository metadata. Merge only after the checks
   pass.
3. Create an annotated tag and GitHub release from the merged commit.
4. From that tag on a clean checkout, run the package checks again.
5. Publish, in this order:

   ```bash
   npm publish --access public
   cd packages/cli && npm publish --access public
   cd ../react && npm publish --access public
   cd ../auth && npm publish --access public
   cd ../email && npm publish --access public
   ```

   `@tapedb/tapedb` → `@tapedb/cli` → `@tapedb/react` → `@tapedb/auth` →
   `@tapedb/email`. The order is forced by the exact pins: every package
   depends on `"@tapedb/tapedb": "<this version>"`, so publishing any of them
   before the core puts a pin on the registry that resolves to nothing, and a
   consumer install fails until the core appears. Publishing in this order is
   the whole guarantee that `@tapedb/react` and `@tapedb/tapedb/react` (and the
   auth and email pairs) are one release. The wrappers may be published in any
   order among themselves; the core must come first.

   Without an npm CI service there is no OIDC token, so this publish carries no
   provenance attestation. Do not add `--provenance` unless the publish runs in
   CI.

6. Verify the registry and the consumer path:

   ```bash
   npm view @tapedb/tapedb version dist-tags.latest
   npm view @tapedb/cli version dist-tags.latest
   npm view @tapedb/react version dist-tags.latest
   npm view @tapedb/auth version dist-tags.latest
   npm view @tapedb/email version dist-tags.latest
   cd "$(mktemp -d)" && npx @tapedb/cli init
   ```

7. Make the GitHub repository public and enable branch protection and secret
   scanning. Update the package page and the documentation links.

## After publishing

- Publish a GitHub release with the changelog.
- Keep the previous version installable and document any migration steps.
- Deprecate the unscoped `tapedb-cli` name in favour of `@tapedb/cli` once the
  scoped package is installable: `npm deprecate tapedb-cli "Moved to @tapedb/cli"`
  (or the equivalent message for the version range that still points at the old
  name). A deprecated package still installs, so this breaks nobody.
- If a release is broken, deprecate it with `npm deprecate` and publish a fixed
  version. Do not rewrite a published version or tag.
- Never put `TAPEDB_CLAIM_SECRET`, claim tokens, Cloudflare credentials or
  customer data in a release, issue, pull request or artifact.
