# @tapedb/cli

The command line for [tapedb](https://tapedb.dev), a typed database for Cloudflare.

```bash
npx @tapedb/cli init     # set up a project: schema, Worker, migrations; run locally or deploy
npx @tapedb/cli dev      # run the database locally, with the studio at http://localhost:8787/
npx @tapedb/cli deploy   # deploy to your Cloudflare account
```

Each run uses the `@tapedb/tapedb` release this package pins. It does **not** install or
upgrade your project's own copy, so `npx @tapedb/cli` and the version in your
`package.json` can differ: pin `@tapedb/tapedb` yourself and keep the two in step.
The library itself is [`@tapedb/tapedb`](https://www.npmjs.com/package/@tapedb/tapedb).

## The command is still `tapedb-cli`

The package is `@tapedb/cli`; the bin it installs is `tapedb-cli`, so
`npx tapedb-cli init` keeps working and generated projects keep the scripts
they were written with. Both run the same file. The unscoped `tapedb-cli`
package name is deprecated in favour of this one; a deprecated package still
installs, so nothing written against it breaks.
