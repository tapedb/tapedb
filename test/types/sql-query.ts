// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, sqlQuery, t } from "../../src/schema";

const app = schema(
  { board: model({ name: t.string() }) },
  {
    queries: {
      stats: sqlQuery({
        params: { prefix: t.string(), since: t.date().optional() },
        returns: { name: t.string(), open: t.number(), last: t.date().optional(), done: t.boolean() },
        sql: "SELECT name, 0 AS open, NULL AS last, 0 AS done FROM board WHERE name LIKE :prefix AND (:since IS NULL OR 1)",
      }),
      everything: sqlQuery({ returns: { n: t.number() }, sql: "SELECT count(*) AS n FROM board" }),
    },
  }
);

const db = createClient({ schema: app, url: "http://localhost:8787", workspace: "w" });

export async function queries() {
  const rows = await db.$query("stats", { prefix: "a" });
  const name: string = rows[0].name;
  const open: number = rows[0].open;
  const last: number | null = rows[0].last;
  const done: boolean = rows[0].done;
  await db.$query("stats", { prefix: "a", since: new Date() });
  await db.$query("everything");
  void [name, open, last, done];

  // @ts-expect-error a declared, required param is required.
  await db.$query("stats", {});
  // @ts-expect-error a param has its declared type.
  await db.$query("stats", { prefix: 1 });
  // @ts-expect-error only declared params.
  await db.$query("stats", { prefix: "a", other: 1 });
  // @ts-expect-error only declared queries.
  await db.$query("nothing");
  // @ts-expect-error an optional date column may be null.
  const strict: number = rows[0].last;
  void strict;
}
