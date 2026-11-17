# tapedb-cli

The command line for [tapedb](https://tapedb.dev), a typed database for Cloudflare.

```bash
npx tapedb-cli init      # set up a project: schema, Worker, migrations; run locally or deploy
npx tapedb-cli dev       # run the database locally, with the studio at http://localhost:8787/
npx tapedb-cli deploy    # deploy to your Cloudflare account
```

Each run uses the newest tapedb and brings the project's `@tapedb/tapedb` up to it.
The library itself is [`@tapedb/tapedb`](https://www.npmjs.com/package/@tapedb/tapedb).
