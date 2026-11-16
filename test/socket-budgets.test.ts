import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { acceptPart } from "../src/engine/socket-state";
import { MAX_SOCKET_MESSAGE_BYTES, MAX_SOCKET_PENDING_MESSAGES } from "../src/socket-protocol";
import type { SqlExecutor } from "../src/engine/tx-sql";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE _socket_parts (client_id TEXT, id TEXT, idx INTEGER, data TEXT, PRIMARY KEY(client_id,id,idx))");
  const sql = {
    exec: (q: string, ...args: unknown[]) => db.query(q).run(...args as never[]).changes,
    one: (q: string, ...args: unknown[]) => db.query(q).get(...args as never[]) ?? undefined,
    all: (q: string, ...args: unknown[]) => db.query(q).all(...args as never[]),
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  } as SqlExecutor;
  return { sql, count: () => db.query("SELECT count(*) AS n FROM _socket_parts").get() };
}

test("unfinished messages per socket are bounded", () => {
  const { sql, count } = fixture();
  for (let n = 0; n < MAX_SOCKET_PENDING_MESSAGES; n++) expect(acceptPart(sql, "client", { id: String(n), index: 0, last: false, data: "x" })).toEqual({ pending: true });
  expect(acceptPart(sql, "client", { id: "overflow", index: 0, last: false, data: "x" })).toEqual({ error: "message_limit_exceeded" });
  expect(count()).toEqual({ n: MAX_SOCKET_PENDING_MESSAGES });
});

test("assembled bytes are checked before loading and joining stored parts", () => {
  const { sql, count } = fixture();
  expect(acceptPart(sql, "client", { id: "big", index: 0, last: false, data: "x".repeat(MAX_SOCKET_MESSAGE_BYTES) })).toEqual({ pending: true });
  expect(acceptPart(sql, "client", { id: "big", index: 1, last: true, data: "x" })).toEqual({ error: "message_limit_exceeded" });
  expect(count()).toEqual({ n: 0 });
});

test("relayed broadcasts use the same byte quota without assembling a whole message", () => {
  const { sql, count } = fixture();
  expect(acceptPart(sql, "client", { id: "topic:t:x", index: 0, last: false, data: "part" }, false)).toEqual({ pending: true });
  expect(acceptPart(sql, "client", { id: "topic:t:x", index: 1, last: true, data: "end" }, false)).toEqual({ complete: true });
  expect(count()).toEqual({ n: 0 });
});
