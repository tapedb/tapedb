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

`studio` opens a local table browser at `http://127.0.0.1:4400`: pick a
namespace, page through rows, switch between the workspaces you have opened,
and send transactions. It proxies through the dev claim route, so it needs no
separate credentials.

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
  offset, so an insert above the window cannot repeat a row. On the client,
  `db.loadMore(query)` appends the next page and widens the live subscription
  to every loaded row (up to 1000 per namespace), so a reconnect restores the
  pages instead of resetting to the first.
- **Live queries** by default: after a commit, only subscriptions whose
  compiled query touches a changed namespace re-run, batched at 50 ms, and
  clients receive entity-level diffs.
- **Offline writes**: optimistic application to the query cache plus an
  IndexedDB outbox keyed by `clientTxId`, replayed on reconnect.
- **Durability**: log segments and chunked snapshots to R2, with an idempotent
  cold-start replay. Verified against a real Worker: rows and the sequence
  survive deleting the Durable Object's entire SQLite (snapshot plus replayed
  segment), and the next transaction continues from the right sequence.
  Recovery rebuilds `_tx_log` from the log segments, so a retried `clientTxId`
  returns `applied: 0` after a cold start - measured live, including for a
  transaction that a snapshot had already folded in. A snapshot stores rows and
  not keys, so covered segments are retained for `DEDUPE_HORIZON_SEQ` (2000
  sequence numbers) past the snapshot base; beyond that the segment is pruned
  and the key with it. A retry from further back is refused, never applied
  twice: the client sends the highest sequence it had seen when it created the
  write (`basisSeq`), and when the restored database no longer holds keys that
  far back the engine answers `dedupe_expired` (409) and applies nothing. The
  client drops the entry and calls `onWriteRejected` so the app can decide.
- **Presence** and **file uploads** on the same socket and the same bucket set.
  Uploads write bytes to R2 and a metadata row into the workspace, through the
  transaction log so a restore keeps it, and
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

## Permissions

Role levels by default: `view` needs MEMBER, `create`/`update` need EDITOR,
`delete` needs MODERATOR. Anything finer is a row rule: a predicate that sees
the caller and the stored row.

```ts
defineSchema({
  entities: {
    documents: { title: { type: "string" }, ownerId: { type: "string" } },
  },
  permissions: {
    documents: {
      create: ({ auth, next }) => next?.ownerId === auth.sub,
      update: ({ auth, data }) => data?.ownerId === auth.sub,
      delete: ({ auth, data }) =>
        data?.ownerId === auth.sub && auth.role >= WORKSPACE_ROLE_LEVELS.EDITOR,
    },
  },
});
```

Rules run inside the transaction, so `data` is the row being changed, and a
replayed `clientTxId` is not re-judged. A rule that throws denies: a broken
rule can never widen access. `update` is an upsert, so an insert must satisfy
the **create** rule, not the update one.

`view` takes two rule forms. Prefer `where`: it returns a filter for the
caller, which is compiled into the query's SQL at every level that reads the
namespace, so it uses indexes and always fills the page.

```ts
permissions: {
  documents: { view: { where: (auth) => ({ ownerId: auth.sub }) } },
  // An array is OR: mine, or anything public.
  notes: { view: { where: (auth) => [{ ownerId: auth.sub }, { isPublic: true }] } },
}
```

The filter uses the same operators as a query's `where`, and it ANDs with the
caller's own filter, so a client cannot widen it. An unsupported operator is an
error rather than ignored, and a rule that throws hides every row. Give the
attribute you filter on `indexed: true`.

When visibility cannot be written as a filter, `view` can be a function:

```ts
permissions: {
  documents: { view: ({ auth, data }) => data?.ownerId === auth.sub },
}
```

Function rules are arbitrary TypeScript, so they run after the SQL page. The
engine then keeps scanning (by keyset when the query has an `order`) until the
page is full, the rows run out, or a cap of `max(limit * 10, 200)` scanned rows
is reached, so a rule that hides almost everything can return a short page.
A rule that throws hides the row.

Rules also receive `changed`, the attribute names an op writes, which is how
one field is gated:

```ts
update: ({ auth, data, changed }) =>
  changed?.includes("price") ? data?.ownerId === auth.sub : true
```

## Releasing

`tapedb` is unscoped, so publishing needs no npm org:

```bash
npm login
npm publish --access public
```

Only a *scoped* release (`@tapedb/*`) needs an org, and orgs are created in the
web UI at `https://www.npmjs.com/org/create`. There is no `npm org create`
command; `npm org` only manages members of an existing org.

## Entry points

| import | contains | React |
| --- | --- | --- |
| `tapedb` | `defineSchema`, schema builders, `id`, cache and outbox primitives | no |
| `tapedb/react` | `init`, `useQuery`, `transact`, `storage`, presence | yes, peer |
| `tapedb/worker` | `defineTapeDB`, the Durable Object class, routing | no |
| `tapedb/cli` | `init`, `dev`, `studio` | no |

## Status

`0.0.1`, extracted from a production application. The engine, the client and
the claim path are exercised by 166 tests, including the upstream engine suite
and a headless client run against a live Worker. Live `wrangler dev` runs cover
init, mint, transact, idempotent replay, nested query, cursor pagination,
upload and listing, and every auth refusal.

Remaining gaps and their trade-offs are tracked in [SCOPE.md](./SCOPE.md).

## License

MIT
