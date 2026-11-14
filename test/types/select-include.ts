// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, t } from "../../src/schema";

const app = schema({
  column: model({ name: t.string(), tasks: t.hasMany("task") }),
  task: model({ title: t.string(), done: t.boolean().default(false), column: t.belongsTo("column").optional() }),
});
declare const db: ReturnType<typeof createClient<typeof app.models>>;

export async function selectAndInclude() {
  const rows = await db.task.findMany({ select: { title: true }, include: { column: { select: { name: true } } } });
  const row = rows[0];
  const title: string = row.title;
  const name: string | undefined = row.column?.name;
  // @ts-expect-error `done` was not selected.
  void row.done;
  return [title, name];
}
