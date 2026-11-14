// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, t } from "../../src/schema";

const app = schema({
  board: model({ name: t.string(), archived: t.boolean().default(false), columns: t.hasMany("column") }),
  column: model({ name: t.string(), board: t.belongsTo("board"), tasks: t.hasMany("task") }),
  task: model({ title: t.string(), done: t.boolean().default(false), column: t.belongsTo("column").optional() }),
});
declare const db: ReturnType<typeof createClient<typeof app.models>>;

export function deep() {
  db.task.findMany({ where: { column: { board: { columns: { some: { tasks: { every: { done: true } } } } } } } });
  // @ts-expect-error four hops down, a task has no field `nope`.
  db.task.findMany({ where: { column: { board: { columns: { some: { tasks: { every: { nope: true } } } } } } } });
  // @ts-expect-error two hops down, a board has no field `title`.
  db.task.findMany({ where: { column: { board: { title: "x" } } } });
}
