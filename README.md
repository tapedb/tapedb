# tapedb

**A typed database for Cloudflare.** Describe your models once; `tapedb init`
generates the Worker and configuration for one Durable Object class and two R2
buckets in your own account. The interactive setup installs project dependencies;
choose local development or let it provision the cloud resources and deploy.
Each workspace gets its own SQLite database inside a Durable Object, every
write is appended to a transaction log, the log ships to R2, and a cold start
replays it. Reads can be awaited once or kept live over a WebSocket; writes
are optimistic and survive going offline.

Think of it as an ORM whose database is Cloudflare: schema in TypeScript,
committed migrations, typed queries — plus live queries and offline writes,
because the engine underneath is built for them. It is a library, not a
service: there is no hosted control plane, and your data never leaves your
account. [PRIVACY.md](PRIVACY.md) covers what is stored where, for how long,
and how to answer GDPR access and erasure requests.

## Project status

Public releases are on npm as `@tapedb/tapedb`, `@tapedb/cli`, `@tapedb/react`,
`@tapedb/auth` and `@tapedb/email`; see the [changelog](CHANGELOG.md) for the
latest changes. The API is described, with what is stable and what is
experimental, in [API.md](API.md); the design boundaries are in
[LIMITATIONS.md](LIMITATIONS.md). The packaged CLI requires Node 22.18 or
newer; the library itself runs in Cloudflare Workers.

```bash
npx @tapedb/cli init     # interactive setup, dependencies and first migration
npx @tapedb/cli dev      # local database, and the studio at http://localhost:8787/
npx @tapedb/cli deploy   # your Cloudflare account: buckets, secrets, Worker
```

No flags are needed: each command asks when it has to, and Enter takes the
default. `@tapedb/cli` pins the core exactly, so `npx @tapedb/cli` runs that
release's CLI and does not touch the copy your project has installed. Both
packages install a `tapedb-cli` command; inside a project, `npx tapedb-cli
<command>` runs the CLI you already have, which is why the hints below spell it
that way.

### Preferred imports

The core is one package; the entries with their own dependency or peer graph
ship as their own package, and each one is a re-export of the core's entry:

| install | import | instead of |
| --- | --- | --- |
| `@tapedb/react` | `import { useLive } from "@tapedb/react"` | `@tapedb/tapedb/react` |
| `@tapedb/auth` | `import { tapedbAuth } from "@tapedb/auth"` | `@tapedb/tapedb/auth` |
| `@tapedb/email` | `import { mailer } from "@tapedb/email"` | `@tapedb/tapedb/email` |

Every `@tapedb/tapedb/<x>` subpath in this README still resolves to the same
module as its package: the subpath is not deprecated, the package is just the
preferred name and pins the core version it ships with.

## The schema

TypeScript checks literal schemas in your editor: relation targets must exist,
each `hasMany` must have one matching `belongsTo` (or an explicit `inverse`),
and personal fields must name a valid subject. Errors identify the model and
field before you run the app. Dynamic schemas still use runtime validation.

```ts
// tapedb.schema.ts
import { check, filter, model, role, schema, t } from "@tapedb/tapedb/schema";

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
`t.date()` (stored as epoch milliseconds), `t.json()`, and `t.enum([...])` for a
string with a closed set of values. Modifiers:
`.optional()`, `.default(v)`, `.index()`, `.unique()`. Relations:
`t.enum` is a string whose values are checked. The column is TEXT and the set is
not part of the migration, so adding or removing a value needs no migration: it
changes what the engine accepts. `Row` and `CreateData` narrow to the union, so a
typo fails in the editor, and `where` narrows too.

```ts
status: t.enum(["pending", "paid", "shipped"]).default("pending"),
kind: t.enum(["current", "savings"]).index(),
```

Use it for sets your own logic defines, not for codes an external standard owns
(currency, country): those change without you, and every change would be a
schema edit.

`t.belongsTo("model")` owns the foreign key (`board` stores `boardId`);
`t.hasMany("model")` is its inverse. Every row carries `id` (client-generated,
time-ordered), `createdAt` and `updatedAt`.

## Reads

```ts
import { createClient } from "@tapedb/tapedb";
import schema from "./tapedb.schema";

const db = createClient({ schema, url, workspace, userId, getToken });

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
It works the same for `findPage` and live subscriptions. `select` and
`include` combine: the selected fields plus the included relations, and a
relation named in both gets the arguments of both.

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
`notIn`, `gt`, `gte`, `lt`, `lte`, `isNull`, `like`, `ilike`, and `AND` / `OR` /
`NOT` over whole filters. Pagination is keyset, so an insert above the window
cannot repeat a row.

```ts
await db.task.findMany({ where: { due: { isNull: true } } });        // never scheduled
await db.task.findMany({ where: { due: { isNull: false } } });       // has a due date
await db.task.findMany({ where: { title: { like: "Replay%" } } });   // starts with "Replay"
await db.task.findMany({ where: { title: { ilike: "%replay%" } } }); // anywhere, either case
```

`isNull` is how a nullable field is asked for as set or not set: an optional
field is stored as null on every row, so `{ due: null }` and
`{ due: { isNull: true } }` read the same rows. It also reads a foreign key like
any other field, but not a relation, where `{ column: null }` already says it.
`like` and `ilike` take SQL wildcards — `%` for any run of characters, `_` for
exactly one, and a backslash making the next `%`, `_` or backslash literal, with
any other backslash refused — and match text only. `like` is case-sensitive;
`ilike` folds ASCII case, so `É` and `é` stay different letters.

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
rule is a function (which only runs after fetch) is applied to the linked
rows before they count, so a filter never matches through a row the rule
hides. The types follow every hop.
Includes and relation filters nest without limit, and filters can be as wide
as you like. A Durable Object's SQLite refuses expressions deeper than 100 and
very long statements, so past a few hops, or past that length, the engine runs
part of the filter first into a scratch table and tests membership in it;
every statement stays shallow and short. The results are the same either way.

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
// React (@tapedb/tapedb/react)
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

### Across workspaces

```ts
const across = db.$across([teamA, teamB, teamC], {
  getToken: (workspaceId) => fetchClaim(workspaceId),
});

const due = await across.task.findMany({ where: { done: false }, orderBy: { due: "asc" }, take: 50 });
// each row carries its workspaceId

const page = await across.task.findPage({ orderBy: { id: "desc" }, take: 50, after });
const open = await across.task.count({ where: { done: false } });

const { data, errors } = useLive(across.task.findMany({ orderBy: { title: "asc" } }));
```

`findMany`, `findFirst`, `findPage` and `count` read every listed workspace,
each with its own claim, and merge the rows in `orderBy` order (the same order
SQLite uses). Without `orderBy`, rows come workspace by workspace. A page's
`cursor` keeps a position in each workspace. Live queries hold one socket per
workspace and update as any of them changes. If a workspace fails, a one-off
read rejects with `AcrossError`: its `errors` name the failed workspaces and
`partial` holds the rest. A live state keeps the other workspaces' rows and
lists the failures in `errors`. Writes and transactions stay in one workspace.

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

Retries are deduplicated by client transaction id without an age limit.
Receipts survive snapshots, replay-log pruning and recovery from R2. Each
transaction keeps a small row containing its random id, sequence and time for
the workspace's lifetime. Its operation hash is removed after half the
[retention](#history-retention), 15 days by default. Until then, reusing an id
with different operations is rejected; afterwards, the id acknowledges the
original write regardless of its body and never applies another write.

An upgrade or restore from an engine that discarded receipts keeps a fixed
boundary for missing receipts. An unknown retry first issued before that
boundary is refused with `retry_expired` (HTTP 410) and reaches
`onWriteRejected`; the app can send it again as a new write. The boundary does
not advance with time. The client sends each write's original `issuedAt`.


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
it, and one failure rolls the whole tree back. The types follow every level.

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

Every matching row is written in one transaction, however many match: the
write commits whole or not at all, and one row refused by a rule rolls it all
back. The engine resolves the filter once, against the database before the
write, then checks, applies and logs the rows a chunk at a time, so memory
stays flat however large the write is; a log entry larger than a Durable
Object row holds is stored in parts.

Like single-row writes, a bulk write is applied to the cache at once and
queued offline. The cache changes the rows it holds that certainly match; a
row whose match depends on a relation, or on a field the cache does not hold,
waits for the engine. The engine resolves the filter when the write reaches
it, so a write queued offline applies to the rows matching then. Queued, the
result is `{ count, queued: true }`, `count` being the cached rows changed.

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
npx tapedb-cli migrate dev --name add_task_priority
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

```bash
npx tapedb-cli migrate rollback                  # back to the schema before the last migration
npx tapedb-cli migrate rollback --to 0004_tags   # back to the schema after 0004_tags
```

`migrate rollback` writes the migration that takes the database back to an
earlier schema, as the next numbered file: workspaces apply it like any other,
and recovery reads data written on either side of it. Renames are undone with
their values; undoing an added field or model discards what was written to it
since, so it needs `--accept-data-loss`. A migration that dropped data cannot
be undone, and rollback says so. It then lists what to change in the schema
code; `migrate check` passes once the code matches. The schema after each
migration is kept in `tapedb/snapshots/`; commit it with the migrations.

`migrate check` fails CI (or a pre-commit hook) when the schema has changes
with no migration. `tapedb deploy` refuses to ship a dev configuration or an
unmigrated schema, then runs `wrangler deploy`.

The studio (`npx tapedb-cli dev`, then `http://localhost:8787/`) makes the same
changes without writing code: a model's Structure tab adds, edits, renames and
deletes fields, and models are created, renamed and deleted from there too.
Each change is shown first as the edit to `tapedb.schema.ts` and the migration
it writes, with what it deletes and how many rows that is; applying it writes
both, exactly as `migrate dev` would, and the local database reloads with it.
Only the edited entries change in the file; comments, rules and formatting stay
as written. Fields written in other ways (helpers, personal fields) are shown as
code and can be renamed or deleted; change them in the file.

In the Data tab, double-click a cell to edit it; edits are marked until "Save
changes" writes them in one transaction. Checkboxes select rows to delete
together, and every delete first says what happens to the rows that point at
it: deleted with it, field cleared, or refused, per the relation's `onDelete`.
"Columns" hides columns, and search matches the start of text fields or an id.
"Export" downloads all rows, the rows a search or filter shows, or the
selected rows as CSV or JSON (dates in ISO 8601). "Import" reads either format
back: every value is checked against its field first, rows with an id update
that row (or create it with that id), rows without one are created, and up to
5,000 rows are written in one transaction.

"Query" runs a call as you write it in the app, such as
`db.task.findMany({ where: { done: false }, include: { column: true } })`, with
suggestions for models, methods and fields. It is read as data and translated
by the client's own code, so it sends what the app would, through the same
access rules. Results show as a table or as the JSON the call returns. A
write (`create`, `update`, `upsert`, `delete`, `updateMany`, `deleteMany`)
first says what it changes, including what a delete takes with it, and runs
when you confirm it.

The deployed Worker serves the studio too, at `https://<your-worker>/_tapedb/studio` (its root redirects there),
when `worker.ts` passes it in (`tapedb init` writes this):

```ts
import { studio } from "@tapedb/tapedb/studio";

const tapedb = defineTapeDB({ schema, migrations, identity, studio });
```

It signs in through `POST /_tapedb/claim` with the app's own session (cookies,
or the Cloudflare Access login), so your identity adapter decides the role, and
every read and write passes the same access rules as in the app. Open a
workspace by its id, or link to one with `?workspace=<id>`; the Worker lists no
workspaces, so an owner of one never learns the ids of others. The structure is
read-only there: change `tapedb.schema.ts` and deploy. The page runs under a
content security policy that allows only its own script, styles and fonts.
Without `studio`, nothing is served at that path.

"Access" lists each model's rules for read, create, update and delete, and the
files' rules: the roles a role rule lets through, what a filter narrows reads
to for whoever the studio is signed in as, and, under `tapedb dev`, each rule
as written in `tapedb.schema.ts`. The button at the top right switches who
that is: under `tapedb dev`, any role and user id; on the deployed Worker,
your own user at your role or a lower one. The data, the query console and
the access table then show and do exactly what that role or user can.

"History" (or the counter on the transaction tape) lists every transaction the
workspace keeps, newest first and live, for admins and owners: what each one
wrote, row by row, with links to the rows, and who wrote it when `audit: true`
is on. It shows values only for models whose read rule lets the caller read
every row, and never personal values. A row's panel lists its own changes, each
linking to its transaction.

### Folding a run before a deploy

A run of small migrations is normal while working and noise in a deployment.
`npx tapedb-cli migrate squash --since <id>` folds that migration and everything
after it into the first one, re-deriving the SQL from the snapshots at each end
of the run, so the result is the net change rather than a concatenation. The
first migration of the run keeps its id, which is why a development database
that already applied the run needs no repair. A run that adds and later drops
the same thing is removed rather than left as an empty file, a run containing a
statement that touched rows is refused, `--name` renames the result and
`--dry-run` reports without writing.

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

File bytes live in the `FILES` bucket (any size, uploaded in parts past
16 MiB); their index, with who uploaded each file, is written through the
transaction log, so a restore keeps it. Presence rides the same
workspace socket.

Who may read, write and delete each file is set in the schema. Without
rules: read `member`, write and delete `editor`. Each rule is a `role()`, a
`fileCheck()` over the caller and the file, or `attachedTo(model, path => id)`,
which makes a file follow its row: readable by whoever can read the row,
writable and deletable by whoever may update it.

```ts
export default schema({ task, project }, {
  files: {
    read: attachedTo("task", (path) => path.split("/")[1]), // tasks/<id>/...
    write: attachedTo("task", (path) => path.split("/")[1]),
    delete: fileCheck(({ auth, file }) => file.uploadedBy === auth.sub),
  },
});
```

The workspace decides each operation before any byte moves, and `list()`
returns only the files the caller may read. A file the caller may not read
answers 404, like one that does not exist. A rule that throws denies, and an
editor's role does not override a rule.

### Presence

```ts
const room = db.$presence("board:" + boardId);
room.set({ name, color });
const peers = await room.peers();                     // includes you, marked isSelf
const others = await room.peers({ includeSelf: false });
const stop = room.subscribe((peers) => render(peers));
room.leave();                                         // this room only
```

A socket holds several rooms at once — up to `maxPresenceRooms` on the Worker,
four by default — so one connection can show who is in each of the boards a
user has open. Leaving one room leaves the others alone, and a disconnect
leaves all of them. A room's peers include your own entry with `isSelf: true`,
so you can draw your own cursor without matching on names; `db.clientId` is the
same id, and `includeSelf: false` leaves you out. The React hook inverts that
default: `usePresence(db, room, presence)` gives you the others, and
`usePresence(db, room, presence, { includeSelf: true })` adds you.

What a socket publishes is bounded twice, and a refusal changes nothing it
already holds: past 8 KiB of presence across all its rooms the server answers
`presence_state_too_large`, and a room past the cap answers
`presence_rooms_exceeded` (`maxPresenceRooms: 1` is one room per socket, `0`
refuses presence).

Who may join a room is the Worker's decision, and the same authorizer covers
broadcast topics:

```ts
export default defineTapeDB({
  schema,
  realtime: {
    authorize: ({ auth, kind, target, action }) =>
      kind !== "presence" ||
      target.startsWith("board:") ||
      auth.role >= WORKSPACE_ROLE_LEVELS.EDITOR,
  },
});
```

It is handed the caller's claim, `kind` (`"presence"` or `"topic"`), the room or
topic, and `action` (`"join"` or `"send"`), and may answer with a promise. A
presence join is decided before anything is stored, so a refusal answers
`presence_denied` and leaves the socket as it was — and the room's subscriber
hears it, rather than having to infer it from a cursor that never appears:

```tsx
const peers = usePresence(db, "board:" + boardId, { name }, {
  onError: ({ code, target }) => console.warn(`could not join ${target}: ${code}`),
});
```

A typing indicator is a convention on top of that payload, with no API of its
own: publish the flag with your presence and read it off the peers.

```tsx
const peers = usePresence(db, "board:" + boardId, { name, typing });
const typing = peers.filter((peer) => (peer.presence as { typing?: boolean })?.typing);

const [typing, setTyping] = useState(false);
useEffect(() => {
  if (!typing) return;
  const timer = setTimeout(() => setTyping(false), 3000);   // a closed tab stops in 3 s
  return () => clearTimeout(timer);
}, [typing]);
```

### Broadcast

Fire-and-forget messages between the clients of a workspace, on the same
socket:

```ts
const board = db.$broadcast<{ kind: "ping"; at: number }>("board:" + boardId);
const stop = board.subscribe((message, from) => flash(from.userId, message));
board.send({ kind: "ping", at: Date.now() });   // false (dropped) while offline

// React (@tapedb/tapedb/react)
const send = useBroadcast(db, "board:" + boardId, (message, from) => flash(from.userId, message));
```

A message reaches every other client listening on the topic, with the
sender's client id and user id; your own messages are not echoed back.
A dropped connection loses nothing recent. Sends made while the socket is
down wait (up to 100 per topic, for 60 seconds; `send` returns `"queued"`)
and go out after reconnecting. The workspace keeps the last 60 seconds of
each topic (`realtime.replaySeconds`, at most 1,000 messages), and a listener
that reconnects gets what it missed before new messages, each once, in
order. Presence converges the same way: after a reconnect the client
publishes its state again and receives everyone else's. Messages are limited to
4 MiB of encoded JSON, including multipart messages. The workspace relays parts
as they arrive, and the receiving client joins them. Pending assembly is bounded
to 8 MiB per socket and 32 MiB per workspace; excess messages are rejected. By default anyone with a claim for the workspace may listen and send, guests included; decide
for the channels on the Worker:

```ts
defineTapeDB({
  schema,
  realtime: {
    authorize: ({ auth, kind, target, action }) =>
      kind !== "topic" ||
      !target.startsWith("admin:") ||
      auth.role >= WORKSPACE_ROLE_LEVELS.ADMIN,
  },
});
```

`topics: { authorize: ({ auth, topic, action }) => … }` is the older spelling
and still works: it covers topic kinds only, and only when `realtime.authorize`
is absent. The presence rules above are written the same way, with `kind ===
"presence"`.

## Export

```ts
for await (const record of db.$export()) {
  if (record.type === "row") save(record.model, record.data);   // typed per model
}
```

```bash
npx tapedb-cli export --workspace <uuid> --out workspace.ndjson   # TAPEDB_TOKEN, or a dev claim
```

The engine streams NDJSON: a `header` line (the models exported, and any the
caller may not read), one `row` line per row — model by model, in id order,
through the same read rules as any query — one `file` line per file in the
index (bytes stay in R2), and an `end` line with counts. Rows are read 1000 at
a time as the stream is consumed, so a large workspace never sits in memory.
Writes keep landing during an export; `end.consistent` is true when none did,
and the export is then the workspace exactly at `end.seq`. An export that
stops early ends with an `error` line instead of `end` (the CLI exits 1).

## Backup and restore

```bash
npx tapedb-cli backup --workspace <uuid> --out ./backup   # TAPEDB_TOKEN, or a dev claim
npx tapedb-cli backup --workspace <uuid> --out ./backup --dry-run
npx tapedb-cli restore --from ./backup --into <uuid> --dry-run
npx tapedb-cli restore --from ./backup --into <uuid>
```

`backup` writes a directory: `rows.ndjson` — the export above, saved as it
arrives, so the `header`, `row`, `file` and `end` records are the engine's own
bytes — `files/<path>` with the bytes of every file the export names, and
`backup.json`, which holds the format, the version, the workspace, the
sequence, the row counts and a sha256 and byte length for each part. An export
that was not consistent (writes landed while it streamed) is refused, because
the copy would not be one point in time, and a directory that already holds a
`backup.json` is not overwritten. `backup --dry-run` streams the same
records, hashes them and prints the counts, and writes nothing — not even the
directory, so it is safe to run against a workspace you are unsure about.
`--workspace` may also come from `TAPEDB_WORKSPACE`, and `--url` defaults to a
local `tapedb dev` on port 8787.

`restore` checks every part against `backup.json` before it writes anything: a
missing file, one changed byte or a truncated export is named and refused, and
the destination is untouched. It then posts the rows through
`POST /engine/workspaces/:id/import` — the path `tapedb move` uses, which
preserves row timestamps — and uploads each file's bytes through the file
route, so the file index and R2 keys are rebuilt for that workspace instead of
copied from the backup. `--into` picks the destination (default: the workspace
the backup came from).

The destination must be empty. Import needs a workspace with no rows or files,
so a restore into one that already holds either is refused before anything is
sent, and running the same restore twice is a clean error rather than a copy on
top of a copy. An erased workspace stays erased (it answers 410), so restore it
into a new one with `--into`. An import that reports a different row count from
`backup.json` fails the run and names both numbers. `--dry-run` verifies every
part and prints the counts and hashes; it writes nothing and sends nothing.

## Audit

```ts
export default defineTapeDB({ schema, audit: true });
```

```ts
const changes = await db.$history({ model: "task", id: task.id });
// [{ seq, at, sub, role, action: "insert" | "update" | "delete" }, ...]
```

With `audit: true` each write records the claim's `sub` and role, in the
local log and in the log lines in R2, and recovery restores them. Every row a
write changes, cascades included, gets a history entry. `$history` returns a
row's entries, oldest first, to admins and owners. The history follows the
[history retention](#history-retention): entries are kept for half of it (15
days by default) and are gone from every copy within it. Raise
`retention.days` for a longer audit. Off by default: without it, no writer
identity is stored, and `$history` answers 409 `audit_disabled`.

## Personal fields

```ts
const person = model({
  email: t.string().personal({ subject: "self" }),
  details: t.json().personal({ subject: "self" }).optional(),
});
// Or use an ordinary string field such as userId as the subject.
await db.$erasePerson(personId); // owner only
```

Personal string and JSON values use AES-GCM with one key per subject. Set
`TAPEDB_KEY_SECRET` to a stable random secret of at least 32 characters with
`wrangler secret put TAPEDB_KEY_SECRET`; `tapedb init` generates a local key.
Wrapped subject keys live in R2 `DATA` under `keys/<workspace>/`; their names
are HMACs of the subject. SQL, snapshots and transaction logs store ciphertext.
Queries and exports decrypt values after applying the caller's access rules.
Personal fields cannot be indexed, filtered, ordered or aggregated.

`$erasePerson(subject)` deletes the subject key. Existing ciphertext becomes
unreadable in current storage, old snapshots, logs and Durable Object recovery
copies. Reads return `null` and list affected fields in `$erased`. Writing new
data for that subject creates a new key that cannot decrypt the erased data.
Files and ordinary fields are removed separately. Keep the wrapping secret
stable across deployments and workspace moves; losing it loses access to all
personal values. Copies of subject keys outside TapeDB can undo erasure.

Enabling `.personal()` encrypts existing rows in resumable batches before the
workspace serves requests. Older plaintext logs, snapshots and Cloudflare
recovery copies still follow their original retention windows; encryption
cannot erase plaintext already held in those copies.

## Seeding

`tapedb` ships no fake names, postcodes or IBAN formats, and it should not: those
are conventions of your domain, and a library that guesses them is right about one
country. What it ships is the runner, so a seeder is a short file of plain
TypeScript instead of an insertion script.

```ts
// tapedb.seed.ts
import { defineSeeder } from "@tapedb/tapedb/seed";
import type app from "./tapedb.schema";

export default defineSeeder<typeof app>(async ({ ctx }) => {
  const users = await ctx.create("user", 20, (rng) => ({
    email: ctx.unique("user", "email", (r) => `user${r.int(1, 1e6)}@mail.test`),
    name: rng.pick(["Sanne", "Bram", "Noor"]),
  }));

  await ctx.create("post", 100, (rng) => ({
    authorId: ctx.ref(users),
    title: rng.pick(["First", "Second"]),
  }));
});
```

```bash
npx tapedb-cli seed --workspace <uuid>             # against `tapedb dev`
npx tapedb-cli seed --workspace <uuid> --dry-run   # check the rows, write none
npx tapedb-cli seed --workspace <uuid> --seed lab  # the same rows every time
```

Dates are the one thing a seed cannot pin on its own: `rng.past()` measures from
now, so pass `from` when the same seed has to give the same dates tomorrow. The
engine's own `createdAt`, `updatedAt` and `updatedSeq` are written at insert, so
they differ between runs whatever the seed.

The same seed writes the same rows, and `rngFor(label)` gives a stream that
depends only on its label, so a row keeps its values whatever else the run did
first. Rows go through the engine's own routes in batches of 500, so access
rules, the tape and the history see them exactly as they see a client's writes.
A `personal()` field is refused: seeded personal data has to go through the app's
own write path, which owns the encryption key.

## Erasing a workspace

```bash
npx tapedb-cli erase --workspace <uuid> --confirm <uuid>   # owner claim: TAPEDB_TOKEN, or a dev claim
```

`DELETE /engine/workspaces/:id` with an owner's claim deletes everything the
workspace holds: its R2 history (the manifest first, so nothing can be
recovered from what remains), its uploaded files, then its Durable Object
storage and alarm. Every step is idempotent: a failed erase (HTTP 500) is
finished by calling it again. Afterwards the workspace answers
`410 workspace_erased` to every request, so a client reconnecting with
queued writes cannot recreate it under the same id. Cloudflare keeps 30 days
of point-in-time recovery for every SQLite-backed Durable Object; tapedb never
restores from it. Ordinary plaintext values remain restorable until that
history ages out. Personal ciphertext loses its key during workspace erasure. That is why the default history
retention is also 30 days.

## Data residency

```bash
npx tapedb-cli init --jurisdiction eu
```

writes `"TAPEDB_JURISDICTION": "eu"` into `wrangler.jsonc` vars and
`"jurisdiction": "eu"` on both R2 buckets (create them with
`wrangler r2 bucket create <name> --jurisdiction eu`). Every workspace's
Durable Object is then created in Cloudflare's EU jurisdiction, where it runs
and stores data only in the EU, and the R2 history and files stay there too.
A room reached outside the configured jurisdiction answers
`500 jurisdiction_mismatch` and stores nothing. `tapedb deploy` refuses a
config where the objects and the buckets disagree. `fedramp` works the same
way.

### Moving existing workspaces

Create destination DATA and FILES buckets in the new jurisdiction. Bind them
as `DATA` and `FILES`, and retain the original buckets as `DATA_FROM` and
`FILES_FROM` with their original jurisdiction. Set `TAPEDB_JURISDICTION` to
the destination and `TAPEDB_MOVE_FROM` to the source (`none`, `eu` or
`fedramp`), then deploy this move-aware configuration. Keep the same namespace;
`WORKSPACE_FROM` is needed only when the source uses a different namespace.

```sh
npx tapedb-cli move --to eu --url https://tapedb-app.<account-subdomain>.workers.dev --workspaces workspaces.txt
```

`--url` is the Worker's origin as `wrangler deploy` printed it: the
`*.workers.dev` host from your `wrangler.jsonc`, or a custom domain you
attached to the Worker.

The file contains one workspace UUID per line. `--workspace <uuid>` moves one.
Use an owner claim in `TAPEDB_TOKEN`; for several workspaces, `--tokens tokens.json`
reads a local object mapping workspace ids to owner tokens. Development uses
the dev claim route. Discovery uses `--discover --account <id> --source-bucket
<name>` and `CLOUDFLARE_API_TOKEN`; `--from eu` selects an EU source bucket.
Include never-flushed workspaces in the id file as they have no R2 manifest.

Until a workspace is ready, reads go to its original room. The move freezes
writes, checkpoints rows and receipts, streams the durable state and indexed
files to the destination, restores it, then switches traffic and removes the
source data. Writes receive retryable `workspace_moving` and remain in the
client outbox. A failed command can be run again to resume; a nonempty
destination is refused. Remove `TAPEDB_MOVE_FROM` and the `_FROM` bindings only
after every workspace has completed its move.

`POST /engine/workspaces/:id/import` imports a complete, consistent NDJSON
export into an empty workspace with an owner claim. Rows and file metadata
are validated, applied and logged atomically. File bytes are transferred by
`tapedb move`. Import preserves row timestamps and records a fixed boundary
for transaction receipts absent from the export.

Locally workerd has no jurisdictions; `tapedb dev` leaves the setting out.

## Claims and identity

The engine verifies a short-lived signed claim and never issues one. Identity
stays yours: implement two methods and the library serves the claim route.

```ts
import { env } from "cloudflare:workers";
import { defineTapeDB, WORKSPACE_ROLE_LEVELS } from "@tapedb/tapedb/worker";
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
    // Optional; these are the defaults.
    limits: {
      ip: { requests: 300, perSeconds: 60 },
      subject: { requests: 30, perSeconds: 60 },
    },
  },
});

export const WorkspaceRoom = tapedb.WorkspaceRoom;
export default tapedb.worker;
```

`POST /_tapedb/claim` returns `{ token, workspaceId, roleLevel, expiresAt, expiresIn }`.
With `role` in the body it mints a claim at that role, which must be the
caller's own role or a lower one: the studio uses this to show a workspace as
a lower role sees it.
The route is rate-limited out of the box: a token bucket per caller IP, checked
before your session lookup, and one per subject, checked after it. The buckets
live in Durable Objects, so a count is exact and global rather than per
location, and they store HMACs of the IP and subject, never the values. Past a
limit the route answers 429 `rate_limited` with `Retry-After`. Set a limit to
`false` (or `limits: false`) to turn it off, and add `allowRequest(key)` for a
check of your own, run after the IP limit with `key` = `claim:<ip>`. If the
limiter cannot be reached, claims go through and the Worker logs
`claim_limit_unavailable`.
The client
 sends it as `Authorization: Bearer <token>` and renews on
reconnect. On the WebSocket, where browsers cannot set that header, it rides
in `Sec-WebSocket-Protocol` as `tapedb.claim.<token>` next to `tapedb`, which
the room selects. A token is never read from the URL, so it stays out of
request logs and browser history. In development, `tapedb dev` enables a dev claim route so the
client needs no session at all; `ENVIRONMENT=production` refuses that route,
and `tapedb deploy` refuses to ship the flag. A deployed test Worker that
needs the route sets a random `TAPEDB_DEV_CLAIMS_TOKEN` secret first; the route
then mints only for requests carrying it in `x-tapedb-dev-token`.

## The studio

`tapedb studio` is one HTML page: a table browser, your schema as an editable
outline, and a graph of the models. No build step, no network at runtime.

The Graph tab draws the models with React Flow, one node per model with its keys
and types, one edge per foreign key labelled `many → 1`, parents to the left of
the rows that point at them. Clicking a node opens it. Every control in the
studio is the studio's own: listboxes with keyboard navigation instead of native
selects, the brand's checkboxes instead of the system's.

React Flow is bundled at build time into a committed string, so the package keeps
zero runtime dependencies and the page stays a single response under one hash per
script and style. `node scripts/gen-studio-graph.mjs` rebuilds it; a test fails
while the bundle is stale.

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
snapshot. Recovery runs in steps that commit their progress, a snapshot
chunk, a log segment or a 256 KiB part of a large write at a time. The first
boot spends at most 15 seconds on it, well inside the 30 seconds Cloudflare
allows; alarms carry on in steps of about 10 seconds, each stopping before a
unit as slow as the slowest so far would overrun it. So a workspace of any
size recovers, and a recovery cut off by a reset or by an R2 read that fails
resumes rather than starting over. Until it is complete the workspace answers
503 `workspace_recovering` with `Retry-After`, never a partial result. The
client waits it out: reads, writes and file requests retry as `Retry-After`
says for up to a minute, and live queries reconnect once it is done.

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
| `@tapedb/tapedb` | `createClient`, schema builders, `id` | no (zero runtime deps) |
| `@tapedb/tapedb/schema` | `schema`, `model`, `t`, `role`, `filter`, `check` | no |
| `@tapedb/react` | `useLive`, `useLivePage`, `usePresence` (alias of `@tapedb/tapedb/react`) | peer (React 19) |
| `@tapedb/tapedb/react` | the same hooks, the core's own entry | peer (React 19) |
| `@tapedb/auth` | `tapedbAuth`, `eraseAuthUser`, `authDatabase` (alias of `@tapedb/tapedb/auth`) | no |
| `@tapedb/email` | `mailer` (alias of `@tapedb/tapedb/email`) | no |
| `@tapedb/tapedb/worker` | `defineTapeDB`, claim helpers | no |
| `@tapedb/tapedb/studio` | `studio`, served at `/_tapedb/studio` | no |
| `@tapedb/tapedb/seed` | `defineSeeder`, `runSeeder` | no |

The CLI is a command, not an import: `npx @tapedb/cli init | migrate | dev | studio
| deploy | export | backup | restore | seed | erase | move` (bin `tapedb-cli`).

[API.md](API.md) is the reference: every export and signature, what is stable
and what is experimental, the HTTP routes, the export format and the error
codes. A test checks the package against it.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue for a security report.

## License

MIT

Browser clients using the default persistent outbox must pass `userId`, matching
the claim subject (`dev-user` with `tapedb dev`). Queues are isolated by backend,
user and workspace. Close and recreate the client when switching accounts. Old
unscoped queues remain quarantined and are never automatically replayed.




### Built-in sign-in

For a new app, choose **With Better Auth** during init, or run:

```sh
npx tapedb-cli init --auth --email-from "<sender-address>"
```

The generated `auth.ts` wires email verification, password reset and magic links to Cloudflare Email Service. Users and sessions live in one dedicated auth Durable Object; workspace roles come from stored membership. Studio's **Users** page handles sign-in, members and sessions. Local email appears in the terminal and Studio inbox without being sent.

Models can reference members with `t.belongsTo("$users")`. Apps continue using Better Auth's own client. See [the auth and email API](API.md#built-in-authentication) for bindings, routes and erasure. Sending email in production requires Workers Paid and a sender domain on Cloudflare; deploy onboards the configured domain.


To use your own React design, add **`tapedb.auth.tsx`** at the project root with a default-exported component. New auth scaffolds are already wired for it; `dev` watches it and `deploy` bundles it with its CSS. Without it, TapeDB serves the branded default. See [custom auth pages](API.md#custom-auth-page) for the component props and existing-app setup.
