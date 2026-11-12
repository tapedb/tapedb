# TapeDB

**A log-structured database for Cloudflare Durable Objects.** One SQLite
database per workspace lives inside a single Durable Object. Every write is a
transaction appended to a log, the log ships to R2, and a cold start replays
it. Clients subscribe to live queries over one WebSocket, with an optimistic
cache and a durable outbox.

You bring the Cloudflare account. TapeDB brings the database.

```bash
npx tapedb init
npx tapedb dev
```

`init` writes four files and needs three resources: one Durable Object class,
and two R2 buckets (`DATA` for the log and snapshots, `FILES` for uploads).
There is no D1 and no hosted control plane. Your data never leaves your
account.

`dev` runs that Worker locally with an in-memory Durable Object and passes
`TAPEDB_DEV_CLAIMS=true` on the command line, which enables
`POST /_tapedb/claim` so the client works with no session and no configuration.
The flag is never written to `wrangler.jsonc` and is also refused when
`ENVIRONMENT` is `production`, so a plain `wrangler deploy` has no dev claim
route.

## Usage

```ts
// tapedb.schema.ts — one schema, two artifacts
import { defineSchema } from "tapedb";

export const schema = defineSchema({
  entities: {
    boards: { name: { type: "string" } },
    columns: { name: { type: "string" }, boardId: { type: "string", optional: true } },
    tasks: { title: { type: "string" }, done: { type: "boolean", optional: true } },
  },
  links: [
    {
      apiName: "boardColumns",
      kind: "one-to-many",
      forward: { namespace: "boards", label: "columns", has: "many" },
      reverse: { namespace: "columns", label: "board", has: "one" },
      foreignKey: { namespace: "columns", attribute: "boardId" },
    },
  ],
});
```

```ts
// worker.ts — the entire Worker entry
import { defineTapeDB } from "tapedb/worker";
import { schema } from "./tapedb.schema";

const tapedb = defineTapeDB({ schema });

export const WorkspaceRoom = tapedb.WorkspaceRoom;
export default tapedb.worker;
```

```tsx
// client (React)
import { init, id } from "tapedb/react";

const db = init({ workspaceId, apiUrl, schema, getToken });

const { data, isLoading } = db.useQuery({ boards: { columns: { tasks: {} } } });

await db.transact([
  db.tx.tasks[taskId].update({ done: true }),
  db.tx.columns[columnId].link({ tasks: taskId }),
]);
```

### Without React

`tapedb` itself is framework-free, with the same socket, cache and outbox:

```ts
import { init } from "tapedb";

const db = init({ workspaceId, schema });   // one import, no config

db.subscribeQuery({ boards: {} }, () => {
  console.log(db.getQueryState({ boards: {} }).data);
});

await db.transact([db.tx.boards[id()].update({ name: "New" })]);
```

## What it does

- **Relational queries** in the shape of the result you want, with nested link
  traversal, compiled to SQL.
- **Transactions** with `update`, `merge`, `delete`, `link` and `unlink`,
  idempotent per `clientTxId`, applied inside one SQLite transaction with the
  log append and the sequence advance.
- **Cursor pagination**: `$: { limit, order }` returns
  `pageInfo[ns].nextCursor`; pass it back as `$: { after }`. Keyset, not
  offset, so an insert above the window cannot repeat a row.
- **Live queries** by default: after a commit, only subscriptions whose
  compiled query touches a changed namespace re-run, batched at 50 ms, and
  clients receive entity-level diffs.
- **Offline writes**: optimistic application to the query cache plus an
  IndexedDB outbox keyed by `clientTxId`, replayed on reconnect.
- **Durability**: log segments and chunked snapshots to R2, with an idempotent
  cold-start replay.
- **Presence** and **file uploads** on the same socket and the same bucket set.
  Uploads write bytes to R2 and a metadata row into the workspace, so
  `GET /engine/workspaces/:id/files` lists what the workspace contains.

## Architecture

One Durable Object per workspace is the only writer, which is what makes
transactions serializable without a lock manager. `_tx_log` is the source of
truth; snapshots are a checkpoint over it.

```
client ──HTTP /transact──▶ Worker ──claim──▶ WorkspaceRoom (SQLite)
   ▲                                             │
   └──WebSocket query:subscribe / presence ◀─────┘
                                                 │
                                          R2 DATA (log + snapshots)
```

## Claims and identity

The engine verifies a short-lived signed claim and never issues one. Identity
stays yours: implement two methods and the library serves the claim route.

```ts
import { defineTapeDB, WORKSPACE_ROLE_LEVELS } from "tapedb/worker";

const tapedb = defineTapeDB({
  schema,
  identity: {
    async getSubject(headers) {
      const session = await auth.api.getSession({ headers });
      return session ? { sub: session.user.id } : null;
    },
    async getRole(workspaceId, sub) {
      const member = await db.membership(workspaceId, sub);
      return member ? WORKSPACE_ROLE_LEVELS[member.role] : null;
    },
  },
});
```

`POST /_tapedb/claim` then returns `{ token, workspaceId, roleLevel, expiresAt }`
and the client sends it as `Authorization: Bearer <token>`. Claims last five
minutes and the client renews on reconnect.

Rate limiting is the deployment's call: pass `allowRequest` to `mintClaim`, or
put the route behind a Cloudflare rate-limit binding.

## Entry points

| import | contains | React |
| --- | --- | --- |
| `tapedb` | `defineSchema`, schema builders, `id`, cache and outbox primitives | no |
| `tapedb/react` | `init`, `useQuery`, `transact`, `storage`, presence | yes, peer |
| `tapedb/worker` | `defineTapeDB`, the Durable Object class, routing | no |
| `tapedb/cli` | `tapedb init` | no |

## Status

`0.0.1`, extracted from a production application. The engine, the client and
the claim path are exercised by 166 tests, including the upstream engine suite
and a headless client run against a live Worker. Live `wrangler dev` runs cover
init, mint, transact, idempotent replay, nested query, cursor pagination,
upload and listing, and every auth refusal.

Remaining gaps are tracked in [SCOPE.md](./SCOPE.md): row-level permissions
(role levels only today) and the absent devtool.

## License

MIT
