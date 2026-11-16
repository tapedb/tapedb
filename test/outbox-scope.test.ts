import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createHeadlessClient } from "../src/client/data-client";
import { createOutbox } from "../src/client/outbox";

const workspace = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const clients: Array<ReturnType<typeof createHeadlessClient>> = [];
beforeEach(() => Object.defineProperty(globalThis, "indexedDB", { value: new IDBFactory(), configurable: true }));
afterEach(() => {
  for (const db of clients.splice(0)) db.close();
  if (original) Object.defineProperty(globalThis, "indexedDB", original);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});
const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.test`;
function client(apiUrl: string, userId: string | undefined, currentSubject: () => string, offline = false) {
  const sent: unknown[] = [];
  const db = createHeadlessClient({ workspaceId: workspace, apiUrl, userId, getToken: async () => token(currentSubject()) }, {
    createWebSocket: () => { throw new Error("no socket in this test"); },
    fetch: async (_url, init) => {
      if (offline) throw new TypeError("offline");
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { seq: 1, applied: 1 } });
    },
  });
  clients.push(db);
  return { db, sent };
}
const ops = [{ op: "insert" as const, namespace: "task", id: "queued", values: { title: "private" } }];

test("persistent writes never move between backends or accounts sharing a workspace id", async () => {
  const first = client("https://a.test", "alice", () => "alice", true);
  expect(await first.db.transact(ops)).toBe("queued");
  first.db.close();
  const otherBackend = client("https://b.test", "alice", () => "alice");
  await otherBackend.db.flushOutbox();
  expect(otherBackend.sent).toEqual([]);
  const otherUser = client("https://a.test", "bob", () => "bob");
  await otherUser.db.flushOutbox();
  expect(otherUser.sent).toEqual([]);
  const sameUser = client("https://a.test", "alice", () => "alice");
  await sameUser.db.flushOutbox();
  expect(sameUser.sent).toHaveLength(1);
});

test("a changed token subject cannot replay or discard the previous user's queue", async () => {
  const first = client("https://a.test", "alice", () => "alice", true);
  await first.db.transact(ops);
  first.db.close();
  const wrongToken = client("https://a.test", "alice", () => "bob");
  await wrongToken.db.flushOutbox();
  expect(wrongToken.sent).toEqual([]);
  await expect(wrongToken.db.transact([{ ...ops[0], id: "new" }])).rejects.toThrow(/token subject differs/);
  wrongToken.db.close();
  const rightToken = client("https://a.test", "alice", () => "alice");
  await rightToken.db.flushOutbox();
  expect(rightToken.sent).toHaveLength(1);
});

test("authenticated persistent clients must name their subject", async () => {
  const { db, sent } = client("https://a.test", undefined, () => "alice");
  await expect(db.transact(ops)).rejects.toThrow(/pass userId/);
  expect(sent).toEqual([]);
});

test("legacy unscoped entries remain quarantined rather than assigned to the next login", async () => {
  const legacy = createOutbox();
  await legacy.add({ clientTxId: "legacy", txId: "legacy", workspaceId: workspace, ops, createdAt: Date.now(), attempts: 1 });
  const { db, sent } = client("https://a.test", "alice", () => "alice");
  await db.flushOutbox();
  expect(sent).toEqual([]);
  expect(await legacy.list(workspace)).toHaveLength(1);
});

test("persistent clients without getToken still require an explicit subject", async () => {
  const db = createHeadlessClient({ workspaceId: workspace, apiUrl: "https://cookie.test" }, {
    createWebSocket: () => { throw new Error("no socket"); },
    fetch: async () => { throw new Error("must reject before requesting a token"); },
  });
  clients.push(db);
  await expect(db.transact(ops)).rejects.toThrow(/pass userId/);
});
