import { check, model, role, schema, t } from "@tapedb/tapedb/schema";

/**
 * The whole database. After changing it, run
 *   npx @tapedb/tapedb migrate dev --name <what changed>
 * and commit what it writes under tapedb/.
 */
export default schema({
  board: model({
    name: t.string(),
    ownerId: t.string().index(),
    archived: t.boolean().default(false),
    columns: t.hasMany("column"),
  }).access({
    // Anyone in the workspace reads; only the owner edits or deletes.
    read: role("member"),
    create: role("editor"),
    update: check(({ auth, row }) => row?.ownerId === auth.sub),
    delete: check(({ auth, row }) => row?.ownerId === auth.sub),
  }),

  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),

  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    due: t.date().optional(),
    column: t.belongsTo("column").optional(),
  }),
});
