/** Shared by the end-to-end scenarios: the schema the e2e project deploys, and its URL. */
import { model, schema, t } from "tapedb/schema";

/** The Worker under test: a local `tapedb dev` by default, or TAPEDB_URL. */
export const BASE = (process.env.TAPEDB_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

export const s = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({ title: t.string(), done: t.boolean().default(false), column: t.belongsTo("column").optional() }),
});

/** Polls `pred` every 50 ms for up to `ms` (longer against a remote Worker). */
export async function until(pred, label, seen = [], ms = process.env.TAPEDB_URL ? 20_000 : 5_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out: ${label}; seen ${JSON.stringify(seen).slice(0, 500)}`);
}
