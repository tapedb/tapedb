import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AuthMembers } from "../src/auth/members";
import type { SqlExecutor } from "../src/engine/tx-sql";
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const sql: SqlExecutor = {
    exec: (q, ...p) => db.query(q).run(...p).changes,
    all: (q, ...p) => db.query(q).all(...p) as never,
    one: (q, ...p) => db.query(q).get(...p) as never,
    transactionSync: (fn) => db.transaction(fn)(),
  };
  return new AuthMembers(sql);
}
test("creating a workspace is the only ownership bootstrap", () => {
  const members = fixture();
  expect(members.role(crypto.randomUUID(), "stranger")).toBeNull();
  const workspace = members.create("owner");
  expect(workspace.role).toBe(6);
  expect(members.role(workspace.id, "owner")).toBe(6);
  expect(members.workspaces("stranger")).toEqual([]);
});
test("only owners change members, roles never escalate above owner", () => {
  const members = fixture(),
    workspace = members.create("owner");
  members.set("owner", workspace.id, "admin", 5);
  expect(() => members.set("admin", workspace.id, "admin", 6)).toThrow(
    "membership_forbidden",
  );
  expect(() => members.set("owner", workspace.id, "owner", 8)).toThrow(
    "invalid_role",
  );
  expect(members.list("admin", workspace.id)).toHaveLength(2);
  expect(() => members.list("stranger", workspace.id)).toThrow(
    "membership_forbidden",
  );
});
test("last-owner checks survive ownership transfer and removal", () => {
  const members = fixture(),
    workspace = members.create("owner");
  expect(() => members.set("owner", workspace.id, "owner", null)).toThrow(
    "last_owner",
  );
  members.set("owner", workspace.id, "next", 6);
  members.set("owner", workspace.id, "owner", 2);
  expect(() => members.set("next", workspace.id, "next", 3)).toThrow(
    "last_owner",
  );
  expect(members.role(workspace.id, "next")).toBe(6);
});
test("erasure requires ownership transfer and keeps retryable workspace jobs", () => {
  const members = fixture(),
    workspace = members.create("owner");
  expect(() => members.prepareErasure("owner")).toThrow(
    "Transfer workspace ownership",
  );
  expect(members.isErasing("owner")).toBe(false);
  members.set("owner", workspace.id, "next", 6);
  expect(members.prepareErasure("owner")).toEqual([workspace.id]);
  expect(() => members.set("next", workspace.id, "owner", 6)).toThrow(
    "user_erasing",
  );
  members.finishErasure("owner");
  expect(members.role(workspace.id, "owner")).toBeNull();
  expect(members.prepareErasure("owner")).toEqual([workspace.id]);
});
test("an owner undergoing erasure cannot leave a workspace ownerless", () => {
  const members = fixture(),
    workspace = members.create("owner");
  members.set("owner", workspace.id, "next", 6);
  members.prepareErasure("owner");
  expect(() => members.set("next", workspace.id, "next", null)).toThrow(
    "last_owner",
  );
  expect(() => members.set("owner", workspace.id, "next", null)).toThrow(
    "membership_forbidden",
  );
  expect(() => members.prepareErasure("next")).toThrow(
    "Transfer workspace ownership",
  );
});
test("trusted adoption registers an existing workspace once without replacing membership", () => {
  const members = fixture(),
    id = crypto.randomUUID();
  members.adopt(id, "owner");
  expect(members.role(id, "owner")).toBe(6);
  expect(() => members.adopt(id, "stranger")).toThrow(
    "workspace_already_registered",
  );
  expect(members.role(id, "stranger")).toBeNull();
});
test("erasure also fences a user who has no workspaces",()=>{
 const members=fixture();expect(members.prepareErasure("new-user")).toEqual([]);
 expect(members.isErasing("new-user")).toBe(true);
 expect(()=>members.create("new-user")).toThrow("user_erasing");
});
