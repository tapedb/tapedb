# tapedb

**A typed database for Cloudflare.** Describe your models once; `tapedb init`
provisions one Durable Object class and two R2 buckets in your own account.
Each workspace gets its own SQLite database inside a Durable Object, every
write is appended to a transaction log, the log ships to R2, and a cold start
replays it. Reads can be awaited once or kept live over a WebSocket; writes
are optimistic and survive going offline.

Think of it as an ORM whose database is Cloudflare: schema in TypeScript,
committed migrations, typed queries — plus live queries and offline writes,
because the engine underneath is built for them. It is a library, not a
service: there is no hosted control plane, and your data never leaves your
account.

```bash
npx tapedb init     # schema, worker, wrangler config, first migration
npx tapedb dev      # local database with a dev claim route
npx tapedb studio   # local table browser on http://127.0.0.1:4400
```

## The schema

```ts
// tapedb.schema.ts
import { check, filter, model, role, schema, t } from "tapedb/schema";

export default schema({
  board: model({
    name: t.string(),
    ownerId: t.string().index(),
    archived: t.boolean().default(false),
    columns: t.hasMany("column"),
  }).access({
    read: filter(({ auth }) => ({ ownerId: auth.sub })),
    update: check(({ auth, row }) => row?.ownerId === auth.sub),
    delete: role("moderator"),
  }),

  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),

  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    due: t.date().optional(),
    meta: t.json().optional(),
    column: t.belongsTo("column").optional(),
  }),
});
```

One `schema()` call produces the engine's table registry, the SQL migrations
and the client's types. Fields: `t.string()`, `t.number()`, `t.boolean()`,
`t.date()` (stored as epoch milliseconds), `t.json()`. Modifiers:
`.optional()`, `.default(v)`, `.index()`, `.unique()`. Relations:
`t.belongsTo("model")` owns the foreign key (`board` stores `boardId`);
`t.hasMany("model")` is its inverse. Every row carries `id` (client-generated,
time-ordered), `createdAt` and `updatedAt`.

## Reads

```ts
import { createClient } from "tapedb";
import schema from "./tapedb.schema";

const db = createClient({ schema, url, workspace, getToken });

const open = await db.task.findMany({
  where: { done: false, due: { lt: Date.now() } },
  orderBy: { due: "asc" },
  take: 50,
  include: { column: { include: { board: true } } },
});

const one = await db.task.findUnique({ where: { id } });   // row or null
const total = await db.task.count({ where: { done: false } });

const page = await db.task.findPage({ orderBy: { due: "asc" }, take: 50 });
// { rows, hasMore, cursor } — pass cursor back as `after`
```

`findMany` returns every matching row unless you pass `take`; `take` and
`findPage` sizes have no ceiling. Wide reads run as bounded statements under
the hood (keyset chunks of 1000 rows, includes hydrated 1000 parents at a
time), so nothing grows into one oversized query.

`select` returns only the fields you name, and relations named in it are
included with their own `select`:

```ts
const titles = await db.task.findMany({
  select: { title: true, column: { select: { name: true } } },
});
// { title: string; column: { name: string } | null }[]
```

The engine reads and sends only those columns (plus the row's id, which live
updates key on), and the result type narrows to match. A live select is only
pushed a change when a selected field changed.
It works the same for `findPage` and live subscriptions; `select` and
`include` are not combined at one level.

Aggregates take the same `where` and return only the measures asked for:

```ts
const stats = await db.task.aggregate({
  where: { done: false },
  _count: true,                       // or { _all: true, due: true } for non-null counts
  _sum: { points: true },
  _avg: { points: true },
  _min: { due: true },
  _max: { due: true },
});

const perColumn = await db.task.groupBy({
  by: ["columnId"],
  _count: true,
  _sum: { points: true },
  orderBy: { columnId: "asc" },
  take: 20,
});
// [{ columnId, _count, _sum: { points } }, ...]
```

They run as one `GROUP BY` statement over the rows the caller may read: a
`filter()` read rule is compiled into it, and a model whose read rule is a
function is folded row by row after the rule runs. Both are live with
`subscribe`, like `count`.

Everything is typed from the schema: a misspelt field in `where` is a compile
error, and `include` / `select` shape the result type. Filters take `not`, `in`,
`notIn`, `gt`, `gte`, `lt`, `lte`, and `AND` / `OR` / `NOT` over whole
filters. Pagination is keyset, so an insert above the window cannot repeat a
row.

Filters can also reach through a relation. A to-one link takes a filter on
the row it points at; a to-many link takes `some`, `every` or `none`:

```ts
await db.column.findMany({ where: { board: { archived: false } } });
await db.board.findMany({ where: { columns: { some: { tasks: { none: {} } } } } });
await db.task.findMany({ where: { column: null } });          // no parent
```

These compile to correlated subqueries, so the linked rows are never fetched.
The linked model's own read rule is compiled into the subquery, so a filter
cannot answer a question about rows the caller may not see; a model whose read
rule is a function (which only runs after fetch) is refused as a filter
target. The types follow one link; further hops are checked by the engine.
Includes nest without limit. Relation filters nest until SQLite's expression
depth in a Durable Object, about eight hops inside one filter; past that the
query is a 400 that says so. Wide filters are not limited: long `in` lists
and `OR`s of hundreds of branches compile to shallow SQL.

Building a query validates it against the schema, so an unknown field,
operator or relation throws there and then, at the call, rather than
resolving to an error later. Everything the engine decides — permissions, a
missing row, a conflict — surfaces when you await the query or in a live
query's `error`.

### Live

The same query object becomes live when you subscribe to it:

```ts
const stop = db.task
  .findMany({ where: { done: false }, orderBy: { due: "asc" } })
  .subscribe(({ data }) => render(data));
```

```tsx
// React (tapedb/react)
const { data, isLoading } = useLive(
  db.task.findMany({ where: { columnId }, orderBy: { position: "asc" } })
);

const feed = useLivePage(db.task.findPage({ orderBy: { id: "desc" }, take: 50 }));
// feed.rows, feed.hasMore, feed.loadMore() — every loaded page stays live and
// survives reconnects, however many are loaded

const peers = usePresence(db, "board:" + boardId, { name, color });
```

After a commit, only subscriptions whose query touches a changed model re-run,
batched at 50 ms, and clients receive row-level diffs. Counts and aggregates stay live too.

## Writes

```ts
const { id } = await db.task.create({
  data: { title: "Ship it", column: { connect: columnId } },
});

await db.task.update({ where: { id }, data: { done: true } });
await db.task.upsert({ where: { id }, create: { title: "A" }, update: { title: "B" } });
await db.task.delete({ where: { id } });

await db.column.update({
  where: { id: columnId },
  data: { tasks: { connect: [a, b], disconnect: [c] } },
});

// Several writes, one log entry, all or nothing
await db.$transaction([
  db.task.update({ where: { id: a }, data: { position: 2 } }),
  db.task.update({ where: { id: b }, data: { position: 1 } }),
]);
```

`create` fails if the id exists; `update` fails if the row is missing;
`upsert` chooses inside the engine's transaction, so it cannot race. Writes
apply optimistically, queue in an IndexedDB outbox while offline, and resolve
to `{ id, status: "applied" | "queued" }`. A write the engine refuses for
good during a background flush reaches `onWriteRejected`.

Retries are deduplicated by client transaction id. Transaction receipts
survive snapshots, replay-log pruning and recovery from R2, so a previously
applied request is acknowledged without applying it again. Reusing an id with
different operations is rejected. Receipts expire with the rest of the history
(half the [retention](#history-retention), 15 days by default). The client
sends when it first issued each write, and a retry issued before that window
is refused with `retry_expired` (HTTP 410) rather than risk applying it twice:
it reaches `onWriteRejected`, and the app can send it again as a new write.

Related rows can be created with the row that needs them:

```ts
await db.board.create({
  data: {
    name: "Launch",
    columns: { create: [{ name: "Todo", position: 1, tasks: { create: { title: "Ship" } } }] },
  },
});

await db.column.create({ data: { name: "Solo", board: { create: { name: "New board" } } } });
```

It is one transaction, ordered so each row exists before anything points at
it, and one failure rolls the whole tree back. The types follow one level;
deeper nesting is checked by the engine.

### Writing many rows

```ts
const { count } = await db.task.updateMany({ where: { done: true }, data: { archived: true } });
await db.task.deleteMany({ where: { columnId: null } });
```

The engine resolves which rows match, inside the transaction, and logs the
rows rather than the filter — a replay has to change what the original
changed, and re-running a filter later cannot promise that. A bulk write
reaches only rows the caller may read, and still runs the row rules for
`update` and `delete` on each one.

Up to 1000 matching rows commit as one transaction. Beyond that the client
writes batches of 1000 in id order, each its own transaction, until the filter
is exhausted; `count` is the total. If a batch fails, `BulkWriteError.written`
says how many rows the earlier batches changed, and running the same call
again carries on with what still matches. Unlike single-row
writes it is not applied optimistically and not queued offline: which rows
match is the engine's answer, not the cache's.

## Access rules

Each model's actions take one of three decisions:

- `role("member" | "editor" | "moderator" | ...)` — a minimum role, checked
  before any SQL. Defaults: read `member`, create/update `editor`, delete
  `moderator`.
- `filter(({ auth }) => where)` — `read` only. Compiled into the SQL of every
  query that touches the model, so it uses indexes, fills every page, and
  counts correctly. An array is OR; the caller's own filter ANDs with it.
- `check(({ auth, row, data, changed }) => boolean)` — any action, arbitrary
  TypeScript. Write checks run inside the transaction next to the write they
  gate. On `read` they scan matching rows until the page is full or the
  result set is exhausted. Counts apply the same visibility rule.
  A rule that throws denies.

## Migrations

```bash
# edit tapedb.schema.ts, then
npx tapedb migrate dev --name add_task_priority
```

`migrate dev` diffs the schema against `tapedb/schema.snapshot.json` and
writes the next numbered SQL file — reviewed and committed like any ORM
migration — plus the bundle `worker.ts` imports. Each workspace's Durable
Object applies pending migrations on its next wake, one transaction per
migration, with foreign keys switched off around it and checked before it
commits (SQLite's documented procedure for schema changes): a migration that
would leave a row pointing at nothing rolls back.

- A new required field needs `.default(...)` or `.optional()`.
- Drops need `--accept-data-loss`; renames need `--rename old=new` or
  `--rename model.old=new`, otherwise they read as a drop plus an add.
- Type, default and reference changes rebuild the table, including tables
  other tables reference: child rows keep their keys and nothing cascades.
- Migrations declare what they changed, so recovery can replay log segments
  and snapshots written under an older schema. Undeclared drift fails closed.

`migrate check` fails CI (or a pre-commit hook) when the schema has changes
with no migration. `tapedb deploy` refuses to ship a dev configuration or an
unmigrated schema, then runs `wrangler deploy`.

## Files and presence

```ts
const file = await db.$files.upload(blob, { path: "avatars/me.png" });
const all = await db.$files.list({ prefix: "avatars/" });
await db.$files.delete("avatars/me.png");

const room = db.$presence("board:" + boardId);
room.set({ name, color });
room.cursor({ x, y });
const stop = room.subscribe((peers) => render(peers));
```

File bytes live in the `FILES` bucket (25 MB cap, member read / editor
write); their index is written through the transaction log, so a restore
keeps it. Presence is ephemeral and rides the workspace socket.

### Broadcast

Fire-and-forget messages between the clients of a workspace, on the same
socket:

```ts
const board = db.$broadcast<{ kind: "ping"; at: number }>("board:" + boardId);
const stop = board.subscribe((message, from) => flash(from.userId, message));
board.send({ kind: "ping", at: Date.now() });   // false (dropped) while offline

// React (tapedb/react)
const send = useBroadcast(db, "board:" + boardId, (message, from) => flash(from.userId, message));
```

A message reaches every other client listening on the topic, with the
sender's client id and user id; your own messages are not echoed back.
Nothing is stored or replayed, and a send while the socket is down is dropped
rather than delivered late. Listening clients rejoin their topics after a
reconnect. By default any member of the workspace may listen and send; decide
per topic on the Worker:

```ts
defineTapeDB({
  schema,
  topics: {
    authorize: ({ auth, topic, action }) =>
      !topic.startsWith("admin:") || auth.role >= WORKSPACE_ROLE_LEVELS.ADMIN,
  },
});
```

## Export

```ts
for await (const record of db.$export()) {
  if (record.type === "row") save(record.model, record.data);   // typed per model
}
```

```bash
npx tapedb export --workspace <uuid> --out workspace.ndjson   # TAPEDB_TOKEN, or a dev claim
```

The engine streams NDJSON: a `header` line (the models exported, and any the
caller may not read), one `row` line per row — model by model, in id order,
through the same read rules as any query — one `file` line per file in the
index (bytes stay in R2), and an `end` line with counts. Rows are read 1000 at
a time as the stream is consumed, so a large workspace never sits in memory.
Writes keep landing during an export; `end.consistent` is true when none did,
and the export is then the workspace exactly at `end.seq`. An export that
stops early ends with an `error` line instead of `end` (the CLI exits 1).

## Claims and identity

The engine verifies a short-lived signed claim and never issues one. Identity
stays yours: implement two methods and the library serves the claim route.

```ts
import { defineTapeDB, WORKSPACE_ROLE_LEVELS } from "tapedb/worker";
import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";

const tapedb = defineTapeDB({
  schema,
  migrations,
  identity: {
    async getSubject(headers) {
      const session = await auth.api.getSession({ headers });
      return session ? { sub: session.user.id } : null;
    },
    async getRole(workspaceId, sub) {
      const member = await memberships.get(workspaceId, sub);
      return member ? WORKSPACE_ROLE_LEVELS[member.role] : null;
    },
  },
});

export const WorkspaceRoom = tapedb.WorkspaceRoom;
export default tapedb.worker;
```

`POST /_tapedb/claim` returns `{ token, workspaceId, roleLevel, expiresAt }`;
the client sends it as `Authorization: Bearer <token>` and renews on
reconnect. In development, `tapedb dev` enables a dev claim route so the
client needs no session at all; `ENVIRONMENT=production` refuses that route,
and `tapedb deploy` refuses to ship the flag.

## Architecture

One Durable Object per workspace is the only writer, which is what makes
transactions serializable without a lock manager. The log is the source of
truth; snapshots are a checkpoint over it, and the local log is trimmed to
the same window R2 keeps.

```
client ──HTTP /transact──▶ Worker ──claim──▶ WorkspaceRoom (SQLite)
   ▲                                             │
   └──WebSocket subscribe / presence ◀───────────┘
                                                 │
                                          R2 DATA (log + snapshots)
```

Durability is tested by deleting the Durable Object's entire SQLite and
rebuilding from R2: rows, sequence numbers, idempotency keys and the file
index all survive, including across schema migrations made since the
snapshot.

### History retention

Old values live on in the workspace's history: the R2 log segments, older
snapshots and the local replay log. tapedb bounds how long. A value deleted or
overwritten at time T is gone from every copy by T + 30 days, also in a
workspace that sees few writes: a workspace with changes snapshots once its
newest snapshot is half the retention old, and superseded snapshots, the log
they cover and covered local log rows are deleted once older than that.
Recovery always keeps the newest snapshot and the log after it.

```ts
export default defineTapeDB({ schema, retention: { days: 14 } }); // at least 2
```

## Entry points

| import | contains | React |
| --- | --- | --- |
| `tapedb` | `createClient`, schema builders, `id` | no (zero runtime deps) |
| `tapedb/schema` | `schema`, `model`, `t`, `role`, `filter`, `check` | no |
| `tapedb/react` | `useLive`, `useLivePage`, `usePresence` | peer |
| `tapedb/worker` | `defineTapeDB`, the Durable Object class | no |
| `tapedb/cli` | `init`, `migrate`, `dev`, `studio`, `deploy` | no |

## Development

TapeDB is under active development and has no public release. The package is
not ready for production use.

## License

MIT
