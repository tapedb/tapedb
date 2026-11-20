/**
 * An embedding on the write path, through the real Durable Object.
 *
 * A vector field is validated before the transaction opens: a wrong length, a
 * non-finite element or an all-zero vector refuses the whole transaction, so no
 * row, receipt or log entry is left behind. What is stored is one
 * `f32le:v1:<base64>` string, and a read returns it only when its `select`
 * names the field.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeVector } from "../src/model/vector";
import { model, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5b01";
const DIMENSIONS = 4;
const VECTOR = [0.1, -0.2, 0.3, 1];

const tapedb = defineTapeDB({
  schema: schema({
    note: model({
      title: t.string(),
      embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
    }),
  }),
});

const env = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: "s".repeat(32), ENVIRONMENT: "development" };

let context: FakeRoomContext;
let room: InstanceType<typeof tapedb.WorkspaceRoom>;

beforeEach(async () => {
  context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
});

function headers() {
  const now = Math.floor(Date.now() / 1000);
  return {
    [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({
      sub: "owner",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
      iat: now,
      exp: now + 600,
    } as never),
    "content-type": "application/json",
  };
}

async function transact(ops: unknown[], clientTxId?: string) {
  return room.fetch(
    new Request("https://room/transact", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ txId: crypto.randomUUID(), ...(clientTxId ? { clientTxId } : {}), ops }),
    })
  );
}

async function query(document: unknown) {
  return room.fetch(
    new Request("https://room/query", { method: "POST", headers: headers(), body: JSON.stringify({ query: document }) })
  );
}

type Rows = { data: { note: Array<Record<string, unknown>> } };

/** The rows of one table, straight out of SQLite. */
function count(table: string): number {
  return (context.db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function stored(id: string): string | null {
  const row = context.db.query(`SELECT embedding FROM "note" WHERE id = ?`).get(id) as { embedding: string | null } | null;
  return row?.embedding ?? null;
}

describe("writing an embedding", () => {
  test("a write stores one string, and a default projection leaves it out", async () => {
    expect((await transact([{ op: "insert", namespace: "note", id: "n1", values: { title: "First", embedding: VECTOR } }])).status).toBe(200);

    const expected = encodeVector(VECTOR, DIMENSIONS);
    expect(expected.startsWith("f32le:v1:")).toBe(true);
    // SQLite holds the string itself, not a blob or a JSON array.
    expect(stored("n1")).toBe(expected);

    const all = (await (await query({ note: {} })).json()) as Rows;
    expect(all.data.note).toHaveLength(1);
    expect(Object.keys(all.data.note[0]!).sort()).toEqual(["createdAt", "id", "title", "updatedAt", "updatedSeq"]);

    const selected = (await (await query({ note: { $: { select: ["id", "embedding"] } } })).json()) as Rows;
    expect(selected.data.note[0]).toEqual({ id: "n1", embedding: expected });
  });

  test("the string a read returns is a value a write accepts", async () => {
    await transact([{ op: "insert", namespace: "note", id: "n1", values: { title: "First", embedding: VECTOR } }]);
    const read = (await (await query({ note: { $: { select: ["embedding"] } } })).json()) as Rows;
    const text = read.data.note[0]!.embedding as string;

    // A log entry, an imported export and a backup all carry the string back
    // through this same validation.
    expect((await transact([{ op: "insert", namespace: "note", id: "n2", values: { title: "Copy", embedding: text } }])).status).toBe(200);
    expect(stored("n2")).toBe(text);
  });

  test("an update that omits the field keeps it, and null clears it", async () => {
    await transact([{ op: "insert", namespace: "note", id: "n1", values: { title: "First", embedding: VECTOR } }]);
    const text = encodeVector(VECTOR, DIMENSIONS);

    expect((await transact([{ op: "patch", namespace: "note", id: "n1", values: { title: "Renamed" } }])).status).toBe(200);
    expect(stored("n1")).toBe(text);

    expect((await transact([{ op: "patch", namespace: "note", id: "n1", values: { embedding: null } }])).status).toBe(200);
    expect(stored("n1")).toBeNull();
  });
});

describe("an embedding that cannot be stored", () => {
  const refused: Array<[string, unknown, string]> = [
    ["a length that is not the declared one", [0.1, 0.2, 0.3], "exactly 4 values; it holds 3"],
    ["one value too many", [0.1, 0.2, 0.3, 1, 2], "exactly 4 values; it holds 5"],
    // JSON has no NaN and no Infinity: a client that sends one sends null,
    // and the refusal names what actually arrived.
    ["NaN, which the wire carries as null", [Number.NaN, 0.2, 0.3, 1], "value 0 is null"],
    ["Infinity, which the wire carries as null", [0.1, Number.POSITIVE_INFINITY, 0.3, 1], "value 1 is null"],
    ["a boolean in a number's place", [0.1, true, 0.3, 1], "value 1 is boolean"],
    ["a value that overflows float32", [1e39, 0.2, 0.3, 1], "overflows"],
    ["an all-zero vector", [0, 0, 0, 0], "at least one non-zero"],
    ["values that round to all zeros", [1e-50, -1e-50, 2e-46, 5e-46], "all zero as float32"],
    ["a value that is not a vector", 42, "must be an array of numbers"],
    ["an unknown codec tag", "f32le:v2:AACAPw==", "is not a vector this build reads"],
  ];

  for (const [name, embedding, message] of refused) {
    test(`${name} is refused before commit, leaving nothing behind`, async () => {
      await transact([{ op: "insert", namespace: "note", id: "ok", values: { title: "Kept", embedding: VECTOR } }]);
      const rowsBefore = count("note");
      const logBefore = count("_tx_log");
      const receiptsBefore = count("_tx_receipts");

      // One good row and one bad embedding in the same transaction: the good
      // row must not survive either.
      const response = await transact(
        [
          { op: "insert", namespace: "note", id: "good", values: { title: "Doomed", embedding: VECTOR } },
          { op: "insert", namespace: "note", id: "bad", values: { title: "Bad", embedding } },
        ],
        `client-${name}`
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_value");
      expect(body.error.message).toContain(message);

      expect(count("note")).toBe(rowsBefore);
      expect(count("_tx_log")).toBe(logBefore);
      expect(count("_tx_receipts")).toBe(receiptsBefore);
      expect(stored("good")).toBeNull();
      // The first write is untouched, so the refusal changed nothing.
      expect(stored("ok")).toBe(encodeVector(VECTOR, DIMENSIONS));
    });
  }

  test("a rejected embedding in an update leaves the stored one in place", async () => {
    await transact([{ op: "insert", namespace: "note", id: "n1", values: { title: "First", embedding: VECTOR } }]);
    const text = encodeVector(VECTOR, DIMENSIONS);

    const response = await transact([
      { op: "patch", namespace: "note", id: "n1", values: { title: "Renamed" } },
      { op: "patch", namespace: "note", id: "n1", values: { embedding: [0, 0, 0, 0] } },
    ]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_value");
    expect(stored("n1")).toBe(text);
    expect((context.db.query(`SELECT title FROM "note" WHERE id = 'n1'`).get() as { title: string }).title).toBe("First");
  });

  test("a filter on an embedding is refused rather than silently matching nothing", async () => {
    const response = await query({ note: { $: { where: { embedding: "f32le:v1:AAAA" } } } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_value");
    expect(body.error.message).toContain("Cannot filter on non-scalar attribute");
  });

  test("ordering by an embedding is refused", async () => {
    const ordered = await query({ note: { $: { order: { embedding: "asc" } } } });
    expect(ordered.status).toBe(400);
    const body = (await ordered.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_value");
    expect(body.error.message).toContain("Cannot order by non-scalar attribute");
  });

  test("grouping and aggregating an embedding are refused", async () => {
    const grouped = await query({ note: { $: { limit: 0, aggregate: { groupBy: ["embedding"], count: true } } } });
    expect(grouped.status).toBe(400);
    expect(((await grouped.json()) as { error: { message: string } }).error.message).toContain("Cannot group by \"embedding\"");

    const measured = await query({ note: { $: { limit: 0, aggregate: { max: ["embedding"] } } } });
    expect(measured.status).toBe(400);
    expect(((await measured.json()) as { error: { message: string } }).error.message).toContain("Cannot take the maximum");
  });
});
