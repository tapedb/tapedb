# Releasing TapeDB

## Current status

The repository is **private** and `package.json` still has `"private": true`.
The version is `0.1.0`, but nothing has been published. Do not create a release
tag or run `npm publish` until every gate below is satisfied.

The design boundaries are in [LIMITATIONS.md](LIMITATIONS.md). The security
model and operator responsibilities are in [SECURITY.md](SECURITY.md).

## Gates

All gates must be true before the repository or package becomes public:

1. `bun install --frozen-lockfile && bun run verify` passes on Node 22.18 or
   newer in CI.
2. The CI secret and history scan is clean, and dependency and GitHub Actions
   updates have been reviewed.
3. The security review covers claims, the trusted claim header, workspace
   isolation, file routes and erasure. Findings are fixed or accepted in
   writing.
4. A clean consumer project installs the packed artifact and exercises writes,
   live queries, an upload, a migration and erasure through the packaged CLI.
5. The changelog and README describe the release and its design boundaries.
6. An independent review and sustained production dogfooding have either
   happened or the maintainer has accepted the remaining risk in writing.
7. The GitHub repository is made public only after the npm package is ready,
   with branch protection or rulesets and secret scanning enabled. GitHub does
   not offer branch protection or rulesets for private repositories on the
   free plan, so this is applied at the visibility change; until then the CI
   checks are advisory.

Gates 3 and 6 cannot be proven by CI alone.

## Package checks

Run these before a tag, from a clean checkout:

```bash
bun install --frozen-lockfile
bun run verify
bun pm pack --destination /tmp/pack
```

The package smoke test inside `verify` installs the tarball under Node in
default npm, CommonJS and ESM projects. It uses Node 22.18 or newer and npm.

Exercise the packed product as a consumer would:

```bash
cd "$(mktemp -d)"
npm init -y
npm install /tmp/pack/tapedb-*.tgz wrangler
npx tapedb init
npx tapedb dev
```

Drive that project through a write, a live subscription, an upload, a
migration and erasure. Do not release on the strength of the unit suite alone.

## Publishing

Only after the gates and checks:

1. Update `CHANGELOG.md` and set the intended version in `package.json`.
2. Open the release pull request and remove `"private": true` there. Keep
   `publishConfig` and the repository metadata. Merge only after CI is green.
3. Create an annotated tag and GitHub release from the merged commit.
4. From that tag on a clean checkout, run the package checks again.
5. Publish with provenance:

   ```bash
   npm publish --provenance --access public
   ```

6. Verify the registry and the consumer path:

   ```bash
   npm view tapedb version dist-tags.latest
   cd "$(mktemp -d)" && npm init -y && npm install tapedb wrangler
   npx tapedb init
   ```

7. Make the GitHub repository public and enable branch protection and secret
   scanning. Update the package page and the documentation links.

## After publishing

- Publish a GitHub release with the changelog.
- Keep the previous version installable and document any migration steps.
- If a release is broken, deprecate it with `npm deprecate` and publish a fixed
  version. Do not rewrite a published version or tag.
- Never put `TAPEDB_CLAIM_SECRET`, claim tokens, Cloudflare credentials or
  customer data in a release, issue, pull request or artifact.
