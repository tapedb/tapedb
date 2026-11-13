# tapedb starter

The smallest app: one schema, one Worker, three Cloudflare resources. It is
what `npx tapedb init` writes, checked in so you can read it without running
anything.

```
tapedb.schema.ts            the models and who may do what
worker.ts                   the Worker entry: the schema, its migrations, two exports
wrangler.jsonc              one Durable Object class, two R2 buckets
tapedb/migrations/*.sql     committed migrations, generated from the schema
tapedb/schema.snapshot.json the schema as of the last migration
tapedb/migrations.gen.ts    the bundle worker.ts imports (generated)
```

## Run it

```bash
npm install
echo "TAPEDB_CLAIM_SECRET=$(openssl rand -base64 32)" > .dev.vars
npm run dev              # tapedb dev: wrangler dev with the dev claim route on
```

Then, from any script or app:

```ts
import { createClient } from "tapedb";
import schema from "./tapedb.schema";

const db = createClient({
  schema,
  url: "http://localhost:8787",
  workspace: "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a", // any UUID: one database each
});

const board = await db.board.create({ data: { name: "Launch", ownerId: "me" } });
await db.column.create({ data: { name: "Todo", board: { connect: board.id } } });

const boards = await db.board.findMany({ include: { columns: { include: { tasks: true } } } });
```

With no `getToken`, the client asks the dev claim route for a token. In
production, pass `getToken` and configure `identity` in `defineTapeDB`.

## Change the schema

```bash
# edit tapedb.schema.ts, then
npm run migrate -- --name add_task_priority
git add tapedb && git commit
```

Each workspace applies new migrations the next time it wakes. A drop needs
`--accept-data-loss`; a rename needs `--rename model.old=new`.

## Deploy

```bash
npx wrangler r2 bucket create tapedb-starter-data
npx wrangler r2 bucket create tapedb-starter-files
npx wrangler secret put TAPEDB_CLAIM_SECRET
# set "ENVIRONMENT": "production" in wrangler.jsonc (or an env), then
npm run deploy           # refuses a dev configuration or an unmigrated schema
```
