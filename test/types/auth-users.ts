import { model, schema, t, type Row } from "../../src/schema";
const app = schema({
  note: model({ author: t.belongsTo("$users"), text: t.string() }),
});
const profile: Row<(typeof app.models)["$users"]["fields"]> = {
  id: "user",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  name: "Owner",
  image: null,
};
void profile;
// @ts-expect-error The built-in users relation is belongsTo, not hasMany.
schema({ note: model({ authors: t.hasMany("$users") }) });
