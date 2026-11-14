// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, t } from "../../src/schema";

const app = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({ name: t.string(), board: t.belongsTo("board"), tasks: t.hasMany("task") }),
  task: model({ title: t.string(), column: t.belongsTo("column").optional() }),
});
declare const db: ReturnType<typeof createClient<typeof app.models>>;

export function deep() {
  db.board.create({
    data: { name: "B", columns: { create: [{ name: "Todo", tasks: { create: [{ title: "a" }] } }] } },
  });
  db.task.create({ data: { title: "t", column: { create: { name: "C", board: { create: { name: "B" } } } } } });
  // @ts-expect-error three levels down, a task has no field `nope`.
  db.board.create({ data: { name: "B", columns: { create: [{ name: "Todo", tasks: { create: [{ title: "a", nope: 1 }] } }] } } });
  // @ts-expect-error three levels down, a board needs a name.
  db.task.create({ data: { title: "t", column: { create: { name: "C", board: { create: {} } } } } });
}
