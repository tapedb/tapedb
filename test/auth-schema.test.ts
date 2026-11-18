import { expect, test } from "bun:test";
import { schema, model, t } from "../src/schema";
test("$users adds a managed profile table only when referenced", () => {
  const plain = schema({ note: model({ text: t.string() }) });
  expect(plain.registry.namespaces.map((n) => n.apiName)).toEqual(["note"]);
  const linked = schema({
    note: model({ author: t.belongsTo("$users"), text: t.string() }),
  });
  const users = linked.registry.namespaces.find((n) => n.apiName === "$users");
  expect(users?.table).toBe("tapedb_users");
  expect(Object.keys(users!.attributes)).toEqual(["name", "image"]);
  expect(linked.graph.note.relations.author.target).toBe("$users");
  expect(linked.graph["$users"].scalars.name).toMatchObject({ kind: "string" });
});
