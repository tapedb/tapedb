# tapedb starter

The smallest consumer: one Worker, one schema, three Cloudflare resources.

This is the same shape `npx tapedb init` writes, checked in so you can read it
without running anything.

```bash
bun install
bunx wrangler r2 bucket create tapedb-starter-data
bunx wrangler r2 bucket create tapedb-starter-files
bunx wrangler secret put TAPEDB_CLAIM_SECRET   # any long random string

# --var enables the dev claim route for this run only. It is never written to
# wrangler.jsonc, so a `wrangler deploy` has no claim route at all.
bunx wrangler dev --var TAPEDB_DEV_CLAIMS:true
```

`.dev.vars` is where `TAPEDB_CLAIM_SECRET` belongs for local development; the
`wrangler secret put` line above is for a deployed Worker.

Then in another shell:

```bash
# mint a development claim (only works because devClaims is on and
# TAPEDB_DEV_CLAIMS is set below)
curl -s -X POST http://localhost:8787/_tapedb/claim \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a"}'
```

Send that token as `Authorization: Bearer <token>` to:

```
POST /engine/workspaces/<workspaceId>/transact
POST /engine/workspaces/<workspaceId>/query
GET  /engine/workspaces/<workspaceId>/schema
GET  /engine/workspaces/<workspaceId>/files
PUT  /engine/workspaces/<workspaceId>/files/<objectKey>
GET  /engine/workspaces/<workspaceId>/websocket
```

A transaction:

```json
{
  "txId": "tx-1",
  "ops": [
    { "op": "update", "namespace": "boards", "id": "board-1", "values": { "name": "Roadmap" } }
  ]
}
```

A query:

```json
{ "query": { "boards": { "$": { "order": { "name": "asc" }, "limit": 10 }, "columns": { "tasks": {} } } } }
```

The next page is `{ "query": { "boards": { "$": { "order": { "name": "asc" }, "limit": 10, "after": "<pageInfo.boards.nextCursor>" } } } }`.
