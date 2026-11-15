import { createClient } from "../../src/model/client";
import { schema, model, t } from "../../src/schema";
const s = schema({ person: model({ userId: t.string(), name: t.string().personal({ subject: "userId" }) }) });
declare const db: ReturnType<typeof createClient<typeof s.models>>;
export async function personalTypes() {
  const rows = await db.person.findMany();
  const value: string | null = rows[0].name;
  // @ts-expect-error An erased personal value is nullable.
  const required: string = rows[0].name;
  // @ts-expect-error Personal values cannot be filtered.
  db.person.findMany({ where: { name: "Alice" } });
  // @ts-expect-error Personal values cannot be ordered.
  db.person.findMany({ orderBy: { name: "asc" } });
  // @ts-expect-error Personal values cannot be aggregated.
  db.person.aggregate({ _min: { name: true } });
  // @ts-expect-error Personal values cannot be counted individually.
  db.person.aggregate({ _count: { name: true } });
  // @ts-expect-error Numeric fields cannot be personal.
  t.number().personal({ subject: "self" });
  // @ts-expect-error Personal ciphertext cannot be indexed.
  t.string().personal({ subject: "self" }).index();
  await db.$erasePerson("user");
  const history = await db.$history({ model: "person", id: "p1" });
  const writer: string | null = history[0].sub;
  // @ts-expect-error Not a model of this schema.
  await db.$history({ model: "nope", id: "p1" });
  void writer;
  return value;
}
