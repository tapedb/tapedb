// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { decodeVector, encodeVector, model, schema, t, type Row } from "../../src/schema";

const app = schema({
  note: model({
    title: t.string(),
    embedding: t.vector({ dimensions: 768 }).optional(),
    picture: t.vector({ dimensions: 4 }),
  }),
});
declare const db: ReturnType<typeof createClient<typeof app.models>>;

export async function vectorTypes() {
  // A write takes the numbers, not the stored string.
  await db.note.create({ data: { title: "x", picture: [1, 2, 3, 4] } });
  // @ts-expect-error The stored form is not an input.
  await db.note.create({ data: { title: "x", picture: "f32le:v1:AAAA" } });
  // @ts-expect-error A required vector field may not be left out.
  await db.note.create({ data: { title: "x" } });
  // Clearing is a value only an optional vector accepts.
  await db.note.update({ where: { id: "n1" }, data: { embedding: null } });
  // @ts-expect-error A required vector cannot be cleared.
  await db.note.update({ where: { id: "n1" }, data: { picture: null } });

  // A default projection types the embedding as possibly absent, because a
  // read leaves it out unless the select names it.
  const rows = await db.note.findMany();
  const maybe: string | null | undefined = rows[0].embedding;
  const title: string = rows[0].title;
  // @ts-expect-error Narrowing to a string needs a selected read.
  const strict: string = rows[0].embedding;

  const selected = await db.note.findMany({ select: { id: true, embedding: true } });
  // Only the named field is there, and the vector is still the stored string.
  const stored: string | null | undefined = selected[0].embedding;
  // @ts-expect-error Not selected.
  selected[0].title;

  // The codec: numbers in, string out, and back.
  const text: string = encodeVector([1, 2, 3, 4], 4);
  const values: number[] = decodeVector(text);
  const checked: number[] = decodeVector(text, 4);
  // @ts-expect-error A codec needs its dimensions.
  encodeVector([1, 2, 3, 4]);

  return [maybe, title, strict, stored, values, checked];
}

export function rowShape() {
  const row: Row<{ title: ReturnType<typeof t.string>; embedding: ReturnType<typeof t.vector> }> = {
    id: "n1",
    createdAt: 0,
    updatedAt: 0,
    title: "x",
  };
  return row;
}
