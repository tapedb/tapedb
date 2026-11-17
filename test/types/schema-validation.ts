import { model, schema, t } from "../../src/schema";
import { createClient } from "../../src/model/client";
import type { HasManyOptions } from "../../src/model/fields";
import type { Models } from "../../src/model/schema";

// @ts-expect-error A belongsTo target must exist.
schema({ task: model({ board: t.belongsTo("missing") }) });
// @ts-expect-error A hasMany target must exist.
schema({ board: model({ tasks: t.hasMany("missing") }) });
// @ts-expect-error A hasMany needs a matching belongsTo on its target.
schema({ board: model({ tasks: t.hasMany("task") }), task: model({ title: t.string() }) });
// @ts-expect-error Two possible parents need an explicit inverse.
schema({ person: model({ tasks: t.hasMany("task") }), task: model({ author: t.belongsTo("person"), reviewer: t.belongsTo("person") }) });
// @ts-expect-error The inverse must be a belongsTo that points back to this model.
schema({ person: model({ tasks: t.hasMany("task", { inverse: "title" }) }), task: model({ title: t.string(), author: t.belongsTo("person") }) });
// @ts-expect-error An inverse to another model does not match.
schema({ person: model({ tasks: t.hasMany("task", { inverse: "board" }) }), board: model({ name: t.string() }), task: model({ board: t.belongsTo("board"), author: t.belongsTo("person") }) });
// @ts-expect-error A personal field's subject must exist.
schema({ person: model({ name: t.string().personal({ subject: "missing" }) }) });
// @ts-expect-error Modifiers must preserve the subject literal.
schema({ person: model({ name: t.string().personal({ subject: "missing" }).optional().default("anonymous") }) });
// @ts-expect-error A subject field must be a non-personal string.
schema({ person: model({ subject: t.number(), name: t.string().personal({ subject: "subject" }) }) });
// @ts-expect-error A subject cannot itself be encrypted.
schema({ person: model({ subject: t.string().personal({ subject: "self" }), name: t.string().personal({ subject: "subject" }) }) });

// Valid: explicit inverses, unpaired belongsTo, cycles, and implicit foreign-key subjects.
const valid = schema({
  person: model({ authored: t.hasMany("task", { inverse: "author" }), reviewed: t.hasMany("task", { inverse: "reviewer" }), name: t.string().personal({ subject: "self" }) }),
  task: model({ author: t.belongsTo("person"), reviewer: t.belongsTo("person").optional(), body: t.json().personal({ subject: "authorId" }).optional() }),
  note: model({ subject: t.string().optional(), body: t.string().personal({ subject: "subject" }).default("empty") }),
  tree: model({ parent: t.belongsTo("tree").optional(), children: t.hasMany("tree") }),
});
declare const db: ReturnType<typeof createClient<typeof valid.models>>;
async function inferredRows() {
  const rows = await db.person.findMany({ include: { authored: true } });
  const author: string = rows[0].authored[0].authorId;
  // @ts-expect-error Schema validation must retain exact relation inference.
  const bad: number = author;
  return rows;
}
void inferredRows;

// Dynamic definitions and separately typed options keep runtime validation.
declare const dynamic: Models;
declare const options: HasManyOptions;
function dynamicSchema() {
  schema(dynamic);
  schema({ person: model({ tasks: t.hasMany("task", options) }), task: model({ author: t.belongsTo("person"), reviewer: t.belongsTo("person") }) });
}
void dynamicSchema;
