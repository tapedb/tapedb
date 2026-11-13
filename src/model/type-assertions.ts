/**
 * Compile-time checks for the model API's inferred types.
 *
 * Nothing imports this file, so it never reaches a bundle; `tsc` checks it
 * with the rest of `src`. Each `@ts-expect-error` is a promise that the line
 * below it does not type-check: if one starts compiling, tsc fails.
 */

import { createClient } from "./client";
import { t } from "./fields";
import { model, schema } from "./schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_value?: T): void {}

const s = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({
    name: t.string(),
    position: t.number(),
    note: t.string().optional(),
    archived: t.boolean().default(false),
    board: t.belongsTo("board"),
    parent: t.belongsTo("column").optional(),
  }),
});

declare const db: ReturnType<typeof createClient<typeof s.models>>;

export async function assertions(): Promise<void> {
  const columns = await db.column.findMany();
  const column = columns[0];
  expectType<Equal<typeof column.name, string>>();
  expectType<Equal<typeof column.note, string | null>>();
  expectType<Equal<typeof column.archived, boolean>>();
  expectType<Equal<typeof column.boardId, string>>();
  expectType<Equal<typeof column.parentId, string | null>>();
  expectType<Equal<typeof column.createdAt, number>>();

  const withBoard = await db.column.findMany({ include: { board: true } });
  expectType<Equal<typeof withBoard[0]["board"]["name"], string>>();

  const withParent = await db.column.findFirst({ include: { parent: true } });
  expectType<Equal<NonNullable<typeof withParent>["parent"], (typeof column & {}) | null>>();

  const boards = await db.board.findMany({ include: { columns: { include: { board: true } } } });
  expectType<Equal<typeof boards[0]["columns"][0]["board"]["name"], string>>();

  const count = await db.column.count();
  expectType<Equal<typeof count, number>>();

  // Required fields must be given; defaults and optionals may be left out.
  await db.column.create({ data: { name: "a", position: 1, board: { connect: "b" } } });
  // @ts-expect-error position is required
  await db.column.create({ data: { name: "a", board: { connect: "b" } } });
  // @ts-expect-error the board is required
  await db.column.create({ data: { name: "a", position: 1 } });
  await db.column.create({ data: { name: "a", position: 1, boardId: "b" } });
  // @ts-expect-error name is a string
  await db.column.update({ where: { id: "x" }, data: { name: 3 } });
  // @ts-expect-error no such field to filter on
  await db.column.findMany({ where: { nope: 1 } });
  // @ts-expect-error not a relation of column
  await db.column.findMany({ include: { tasks: true } });
  // @ts-expect-error findUnique needs an id
  await db.column.findUnique({ where: {} });

  // Relation filters: one hop is typed against the target's own fields.
  await db.column.findMany({ where: { board: { name: "Roadmap" } } });
  await db.column.findMany({ where: { board: null } });
  await db.board.findMany({ where: { columns: { some: { position: { gt: 2 } } } } });
  await db.board.findMany({ where: { columns: { none: {} }, name: "x" } });
  // @ts-expect-error the target has no such field
  await db.column.findMany({ where: { board: { nope: 1 } } });
  // @ts-expect-error a to-many link needs some, every or none
  await db.board.findMany({ where: { columns: { name: "x" } } });
  // @ts-expect-error a to-one link is filtered directly
  await db.column.findMany({ where: { board: { some: { name: "x" } } } });

  // select narrows the row to the named fields, at every level.
  const picked = await db.column.findMany({ select: { name: true, boardId: true } });
  expectType<Equal<keyof (typeof picked)[0], "name" | "boardId">>();
  expectType<Equal<(typeof picked)[0]["name"], string>>();
  const nestedPick = await db.board.findFirst({
    select: { id: true, columns: { select: { position: true }, orderBy: { position: "asc" } } },
  });
  expectType<Equal<keyof NonNullable<typeof nestedPick>, "id" | "columns">>();
  expectType<Equal<keyof NonNullable<typeof nestedPick>["columns"][0], "position">>();
  const withSelectedParent = await db.column.findMany({ include: { parent: { select: { name: true } } } });
  expectType<Equal<keyof NonNullable<(typeof withSelectedParent)[0]["parent"]>, "name">>();
  const page = await db.column.findPage({ select: { note: true } });
  expectType<Equal<keyof (typeof page)["rows"][0], "note">>();
  const unique = await db.column.findUnique({ where: { id: "x" }, select: { archived: true } });
  expectType<Equal<keyof NonNullable<typeof unique>, "archived">>();
  db.column.findMany({ select: { name: true } }).subscribe((state) => {
    expectType<Equal<keyof NonNullable<typeof state.data>[0], "name">>();
  });
  // @ts-expect-error not a field of column
  await db.column.findMany({ select: { nope: true } });

  // Aggregates: only the measures asked for, typed per field.
  const stats = await db.column.aggregate({
    _count: true,
    _sum: { position: true },
    _min: { name: true, createdAt: true },
  });
  expectType<Equal<typeof stats._count, number>>();
  expectType<Equal<typeof stats._sum.position, number | null>>();
  expectType<Equal<typeof stats._min.name, string | null>>();
  expectType<Equal<typeof stats._min.createdAt, number | null>>();
  // @ts-expect-error no average was asked for
  stats._avg;
  const counted = await db.column.aggregate({ _count: { _all: true, note: true } });
  expectType<Equal<keyof typeof counted._count, "_all" | "note">>();
  const groups = await db.column.groupBy({ by: ["boardId", "archived"], _avg: { position: true }, orderBy: { boardId: "desc" } });
  expectType<Equal<(typeof groups)[0]["boardId"], string>>();
  expectType<Equal<(typeof groups)[0]["archived"], boolean>>();
  expectType<Equal<(typeof groups)[0]["_avg"]["position"], number | null>>();
  // @ts-expect-error a string cannot be summed
  await db.column.aggregate({ _sum: { name: true } });
  // @ts-expect-error a boolean has no minimum
  await db.column.aggregate({ _min: { archived: true } });
  // @ts-expect-error json cannot key a group
  await db.board.groupBy({ by: ["columns"], _count: true });
}
