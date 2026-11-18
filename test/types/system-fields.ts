// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, t } from "../../src/schema";

const app = schema({
  note: model({ title: t.string(), done: t.boolean().default(false) }),
});

declare const db: ReturnType<typeof createClient<typeof app.models>>;

export function systemFields() {
  // Readable, sortable, filterable and groupable.
  db.note.findMany({ orderBy: { createdAt: "desc" } });
  db.note.findMany({ orderBy: [{ updatedSeq: "desc" }, { title: "asc" }] });
  db.note.findMany({ where: { createdAt: { lt: new Date() }, updatedSeq: { gte: 1 } } });
  db.note.groupBy({ by: ["createdAt"], _count: true });
  db.note.aggregate({ _max: { updatedAt: true } });

  // @ts-expect-error `updatedSeq` is a number, not a date.
  db.note.findMany({ where: { updatedSeq: { lt: new Date() } } });
  // @ts-expect-error the engine owns the timestamps; a create cannot set one.
  db.note.create({ data: { title: "x", createdAt: new Date() } });
  // @ts-expect-error and neither can an update.
  db.note.update({ where: { id: "n1" }, data: { updatedSeq: 5 } });
}
