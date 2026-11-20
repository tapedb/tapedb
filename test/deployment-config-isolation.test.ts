/**
 * Two deployments in one process: each room answers from its own configuration.
 *
 * A Worker isolate runs `defineTapeDB` once, but the same engine also runs in
 * Node (`@tapedb/tapedb/backend`) and in the test suite, where two deployments
 * share one process. Engine settings used to live in module-level `let`s that
 * the last `defineTapeDB` overwrote. That was a real leak, not a theory:
 * `test/transaction-log.test.ts` turns audit on for its own deployment and
 * `test/engine/tx-pipeline.test.ts` then saw a non-null `user_id` it never
 * asked for.
 *
 * Every case here builds both deployments in one process with opposite
 * settings — audit on vs off, role file rules vs a code check, different
 * presence-room caps, webhooks vs none — and asserts each behaves as its own
 * deployment configured it. Nothing is reset between them: a `beforeEach` that
 * put the globals back would hide exactly the defect this file is about.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { fileCheck, model, role, schema, t } from "../src/schema";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;

  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "deployment-config-isolation-secret-32c";

const task = model({ title: t.string() });

/** A schema with no file rules: role levels decide, as they always have. */
const plain = () => schema({ task });

type Room = { room: { fetch(request: Request): Promise<Response>; webSocketMessage(ws: unknown, data: string): Promise<void> };
  context: FakeRoomContext;
  db: Database };

/** One workspace storage (its own SQLite and R2) for one deployment's room. */
async function openRoom(
  tapedb: ReturnType<typeof defineTapeDB>,
  options: { workspaceId?: string } = {}
): Promise<Room> {
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, options.workspaceId ?? WORKSPACE);
  const env = {
    DATA: new FakeR2Bucket(),
    FILES: new FakeR2Bucket(),
    TAPEDB_KEY_SECRET: "k".repeat(32),
    ENVIRONMENT: "development",
  };
  const room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
  return { room: room as never, context, db };
}

function claimHeaders(sub = "olivia", level: number = WORKSPACE_ROLE_LEVELS.OWNER): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  return {
    [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({
      sub,
      workspaceId: WORKSPACE,
      role: level,
      iat: now,
      exp: now + 600,
    } as never),
    "content-type": "application/json",
  };
}

/** One insert through the room's own transaction route. */
async function write(room: Room["room"], id: string): Promise<void> {
  const response = await room.fetch(
    new Request("https://room/transact", {
      method: "POST",
      headers: claimHeaders(),
      body: JSON.stringify({ txId: crypto.randomUUID(), ops: [{ op: "insert", namespace: "task", id, values: { title: id } }] }),
    })
  );
  expect(response.status).toBe(200);
}

/** The writer recorded on the newest log row: null unless this deployment audits. */
function newestWriter(db: Database): string | null {
  const row = db.query('SELECT user_id FROM "_tx_log" ORDER BY seq DESC LIMIT 1').get() as
    | { user_id: string | null }
    | null;
  if (row === null) throw new Error("The write was not logged.");
  return row.user_id;
}

async function schemaDocument(room: Room["room"]): Promise<Record<string, unknown>> {
  const response = await room.fetch(new Request("https://room/schema", { headers: claimHeaders() }));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function statusOf(room: Room["room"]): Promise<Record<string, unknown>> {
  const response = await room.fetch(new Request("https://room/status", { headers: claimHeaders() }));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("deployment configuration belongs to the deployment", () => {
  test("a deployment that audits does not make the next one audit", async () => {
    // The reproduced defect, in the direction it was observed: the auditing
    // deployment is defined second and used to turn recording on for everyone.
    const unaudited = defineTapeDB({ schema: plain() });
    const audited = defineTapeDB({ schema: plain(), audit: true });

    const first = await openRoom(unaudited);
    const second = await openRoom(audited);

    await write(first.room, "t1");
    await write(second.room, "t2");

    // The deployment that never asked records no writer...
    expect(newestWriter(first.db)).toBeNull();
    // ...while the one that did records it, in the same process.
    expect(newestWriter(second.db)).toBe("olivia");
  });

  test("a deployment without audit does not silence one that audits", async () => {
    // The same leak mirrored: defining a second, non-auditing deployment used
    // to clear the flag for the first, so its writes stopped being attributed.
    const audited = defineTapeDB({ schema: plain(), audit: true });
    const unaudited = defineTapeDB({ schema: plain() });

    const first = await openRoom(audited);
    const second = await openRoom(unaudited);

    await write(first.room, "t1");
    await write(second.room, "t2");

    expect(newestWriter(first.db)).toBe("olivia");
    expect(newestWriter(second.db)).toBeNull();
  });

  test("file rules stay with the deployment that set them", async () => {
    const byRole = defineTapeDB({
      schema: schema({ task }, { files: { read: role("editor") } }),
    });
    const byCheck = defineTapeDB({
      schema: schema({ task }, { files: { read: fileCheck(({ file }) => file.uploadedBy === "alice") } }),
    });

    const strict = await openRoom(byRole);
    const code = await openRoom(byCheck);

    const strictFiles = ((await schemaDocument(strict.room)).data as { files: { read: Record<string, unknown> } }).files;
    const codeFiles = ((await schemaDocument(code.room)).data as { files: { read: Record<string, unknown> } }).files;

    expect(strictFiles.read).toEqual({ rule: "role", role: WORKSPACE_ROLE_LEVELS.EDITOR });
    expect(codeFiles.read).toEqual({ rule: "check" });
  });

  test("presence-room caps are the calling deployment's", async () => {
    const single = defineTapeDB({ schema: plain(), realtime: { maxPresenceRooms: 1 } });
    const several = defineTapeDB({ schema: plain(), realtime: { maxPresenceRooms: 3 } });

    const capped = await openRoom(single);
    const roomy = await openRoom(several);

    const cappedSocket = socket(capped);
    const roomySocket = socket(roomy);

    // The capped deployment refuses a second room, whatever the other one allows.
    await join(capped, cappedSocket, "board:A");
    await join(capped, cappedSocket, "board:B");
    expect(lastMessage(cappedSocket)).toMatchObject({ type: "error", code: "presence_rooms_exceeded" });

    // Three rooms fit in the other deployment, in the same process.
    for (const target of ["board:A", "board:B", "board:C"]) {
      await join(roomy, roomySocket, target);
      expect(lastMessage(roomySocket)).toMatchObject({ type: "presence:update", target });
    }
  });

  test("webhooks are delivered by the deployment that configured them", async () => {
    const delivering = defineTapeDB({
      schema: plain(),
      webhooks: [{ url: "https://consumer.test/hook", events: ["create"], secret: "whsec_isolation" }],
    });
    const quiet = defineTapeDB({ schema: plain() });

    const withHooks = await openRoom(delivering);
    const withoutHooks = await openRoom(quiet);

    const configured = await statusOf(withHooks.room);
    const notConfigured = await statusOf(withoutHooks.room);

    expect(configured.webhooks).toBeDefined();
    expect(notConfigured.webhooks).toBeUndefined();
  });
});

// ---- Sockets ------------------------------------------------------------------

class FakeSocket {
  readonly sent: unknown[] = [];
  attachment: unknown;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  deserializeAttachment(): unknown {
    return this.attachment === undefined ? undefined : (JSON.parse(JSON.stringify(this.attachment)) as unknown);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value)) as unknown;
  }

  close(): void {
    this.closed = true;
  }
}

/** A connected client of one room: the attachment a hibernated socket keeps. */
function socket(workspace: Room): FakeSocket {
  const now = Math.floor(Date.now() / 1000);
  const ws = new FakeSocket();
  ws.attachment = {
    clientId: `client-${workspace.context.sockets.length + 1}`,
    sub: "olivia",
    role: WORKSPACE_ROLE_LEVELS.OWNER,
    exp: now + 600,
    subscriptions: [],
  };
  workspace.context.sockets.push(ws);
  return ws;
}

async function join(workspace: Room, ws: FakeSocket, target: string): Promise<void> {
  await workspace.room.webSocketMessage(
    ws as never,
    JSON.stringify({ type: "presence:set", target, presence: { name: "olivia" } })
  );
}

function lastMessage(ws: FakeSocket): Record<string, unknown> | undefined {
  return ws.sent.at(-1) as Record<string, unknown> | undefined;
}
