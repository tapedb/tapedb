/** Shared by the end-to-end scenarios: the schema the e2e project deploys, and its URL. */
import { fileCheck, model, schema, sqlQuery, t } from "@tapedb/tapedb/schema";

/** The Worker under test: a local `tapedb dev` by default, or TAPEDB_URL. */
export const BASE = (process.env.TAPEDB_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

export const s = schema({
  person: model({ name: t.string().personal({ subject: "self" }), data: t.json().personal({ subject: "self" }).optional() }),
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({ title: t.string(), done: t.boolean().default(false), column: t.belongsTo("column").optional() }),
}, {
  // File rules, so every file scenario runs through the workspace's decision:
  // nothing under sealed/ may be read or written, whatever the role.
  files: {
    read: fileCheck(({ file }) => !file.path.startsWith("sealed/")),
    write: fileCheck(({ file }) => !file.path.startsWith("sealed/")),
  },
  // Named SQL queries, run in workerd by sql.mjs.
  queries: {
    columnStats: sqlQuery({
      params: { boardId: t.string() },
      returns: { name: t.string(), open: t.number() },
      sql: `WITH open AS (SELECT column_id, count(*) AS n FROM task WHERE done = 0 GROUP BY column_id)
            SELECT c.name, coalesce(o.n, 0) AS open FROM "column" c LEFT JOIN open o ON o.column_id = c.id
            WHERE c.board_id = :boardId ORDER BY c.position`,
    }),
    countdown: sqlQuery({
      params: { upto: t.number() },
      returns: { i: t.number() },
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < :upto) SELECT i FROM n`,
    }),
    people: sqlQuery({ returns: { n: t.number() }, sql: `SELECT count(id) AS n FROM person` }),
  },
});

/** Polls `pred` every 50 ms for up to `ms` (longer against a remote Worker). */
export async function until(pred, label, seen = [], ms = process.env.TAPEDB_URL ? 20_000 : 5_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out: ${label}; seen ${JSON.stringify(seen).slice(0, 500)}`);
}
