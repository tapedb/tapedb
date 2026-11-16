import { expect, test } from "@playwright/test";

const workspace = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const other = "7f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

test("offline write survives a full page reload and replays the identical transaction", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => { (window as any).tapedb = await import("/client.js"); });
  await context.setOffline(true);
  const before = await page.evaluate(async (workspace) => {
    const { client, createOutbox, scopedOutboxName } = (window as any).tapedb;
    const db = client(workspace);
    const status = await db.transact([{ op: "insert", namespace: "task", id: "offline", values: { title: "kept after reload" } }]);
    db.close();
    return { status, entries: await createOutbox({ dbName: scopedOutboxName(location.origin, "browser-user") }).list(workspace) };
  }, workspace);
  expect(before.status).toBe("queued");
  expect(before.entries).toHaveLength(1);
  await context.setOffline(false);
  await page.reload();
  const sent = page.waitForRequest(request => request.url().endsWith("/transact"));
  await page.evaluate(async workspace => {
    const { client } = await import("/client.js");
    (window as any).db = client(workspace);
    await (window as any).db.flushOutbox();
  }, workspace);
  const replay = (await sent).postDataJSON();
  expect(replay).toMatchObject({
    txId: before.entries[0].txId, clientTxId: before.entries[0].clientTxId,
    issuedAt: before.entries[0].createdAt, ops: before.entries[0].ops,
  });
  await expect.poll(() => page.evaluate(async workspace => {
    const { createOutbox, scopedOutboxName } = await import("/client.js");
    return (await createOutbox({ dbName: scopedOutboxName(location.origin, "browser-user") }).list(workspace)).length;
  }, workspace)).toBe(0);
});

test("committed entries are isolated by workspace and removed durably", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ workspace, other }) => {
    const { createOutbox } = await import("/client.js");
    const outbox = createOutbox({ dbName: "workspace-test" });
    const entry = (id: string, workspaceId: string) => ({ clientTxId: id, txId: id, workspaceId, createdAt: 1, attempts: 1, ops: [] });
    await outbox.add(entry("a", workspace));
    await outbox.add(entry("b", other));
    const before = await outbox.list(workspace);
    await outbox.clear(workspace);
    const remaining = await createOutbox({ dbName: "workspace-test" }).list(other);
    await outbox.remove("b");
    return { before, remaining, after: await outbox.list(other), cleared: await outbox.list(workspace) };
  }, { workspace, other });
  expect(result.before.map((e: any) => e.clientTxId)).toEqual(["a"]);
  expect(result.remaining.map((e: any) => e.clientTxId)).toEqual(["b"]);
  expect(result.after).toEqual([]);
  expect(result.cleared).toEqual([]);
});

test("a transaction aborted after put succeeds does not lose the queued write", async ({ page }) => {
  await page.goto("/");
  const entries = await page.evaluate(async workspace => {
    const { createOutbox } = await import("/client.js");
    const outbox = createOutbox({ dbName: "abort-test" });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args as [any]);
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    };
    try {
      await outbox.add({ clientTxId: "aborted", txId: "aborted", workspaceId: workspace, createdAt: 1, attempts: 1, ops: [] });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    return outbox.list(workspace);
  }, workspace);
  expect(entries.map((e: any) => e.clientTxId)).toEqual(["aborted"]);
});
