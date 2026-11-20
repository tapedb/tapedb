/**
 * Broadcast topics, from the client's side: where a subscription stands in a
 * topic's sequence, and what happens when the replay window dropped messages
 * while it was away.
 *
 * No engine and no Worker here — a fake socket plays the room, so every
 * assertion is about what the client concludes from what the wire said. A
 * stream that cannot say it lost something is only resumable in theory, so a
 * gap is reported: never thrown, and never a reason to drop what did arrive.
 */

import { describe, expect, test } from "bun:test";

import { MemoryOutbox } from "../src/client/outbox";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const TOPIC = "board:1";

const appSchema = schema({
  task: model({ title: t.string() }),
});

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {}

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client() {
  const sockets: FakeSocket[] = [];
  const db = createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      fetch: async () => {
        throw new Error("broadcast does not go over HTTP");
      },
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }
  );
  return { db, sockets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits for the socket the client opened, then hands it a session. */
async function session(sockets: FakeSocket[], index = -1): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await tick();
  const socket = index < 0 ? sockets.at(-1)! : sockets[index];
  socket.onopen?.({});
  socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
  await tick();
  return socket;
}

/** One broadcast as the room sends it: `origin` is the sender's client id. */
function message(seq: number, text: string, origin?: string) {
  return {
    type: "topic:message",
    topic: TOPIC,
    seq,
    message: text,
    from: { clientId: "c2", sub: "bob" },
    ...(origin === undefined ? {} : { origin }),
  };
}

/** Opens a subscription on the topic and records what it hears. */
async function listening() {
  const { db, sockets } = client();
  const topic = db.$broadcast<string>(TOPIC);
  const heard: string[] = [];
  const gaps: Array<{ topic: string; expected: number; received: number }> = [];
  const stop = topic.subscribe((text) => heard.push(text), { onGap: (gap) => gaps.push(gap) });
  const socket = await session(sockets);
  socket.push({ type: "topic:joined", topic: TOPIC, seq: 0 });
  return { db, sockets, topic, socket, heard, gaps, stop };
}

describe("broadcast gap detection", () => {
  test("contiguous messages report no gap, and lastSeq follows them", async () => {
    const { topic, socket, heard, gaps } = await listening();
    expect(topic.lastSeq).toBe(0);
    expect(topic.gap).toBeNull();

    for (const seq of [1, 2, 3]) socket.push(message(seq, `m${seq}`));

    expect(heard).toEqual(["m1", "m2", "m3"]);
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(3);
    expect(topic.gap).toBeNull();
  });

  test("a jump reports one gap with the first missing sequence and the one that arrived", async () => {
    const { topic, socket, heard, gaps } = await listening();
    socket.push(message(1, "one"));
    socket.push(message(2, "two"));
    expect(topic.lastSeq).toBe(2);

    // 3 and 4 are gone: the replay window dropped them while we were away.
    socket.push(message(5, "five"));
    socket.push(message(6, "six"));

    expect(gaps).toEqual([{ topic: TOPIC, expected: 3, received: 5 }]);
    expect(topic.gap).toEqual({ topic: TOPIC, expected: 3, received: 5 });
    // Silent but exposed: what did arrive is still delivered.
    expect(heard).toEqual(["one", "two", "five", "six"]);
    expect(topic.lastSeq).toBe(6);
  });

  test("replayed messages already seen are deduped and report no gap", async () => {
    const { topic, socket, heard, gaps } = await listening();
    for (const seq of [1, 2, 3]) socket.push(message(seq, `m${seq}`));

    // A replay overlaps what arrived live: the same sequences again.
    for (const seq of [2, 3]) socket.push(message(seq, `m${seq}`));

    expect(heard).toEqual(["m1", "m2", "m3"]);
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(3);
  });

  test("a client's own replayed messages are not a gap", async () => {
    const { db, topic, socket, heard, gaps } = await listening();
    // Learn this client's origin on another topic, so this one is untouched.
    // A sender's own frames are never delivered to it live, which is exactly
    // why replaying them later can look like a jump.
    db.$broadcast<string>("warmup").send("hello");
    const origin = (socket.sent.at(-1) as { origin: string }).origin;

    for (const seq of [1, 2, 3]) socket.push(message(seq, `m${seq}`));

    // Ours, replayed back on a later connection: 4 and 5 were ours as well.
    socket.push(message(6, "mine", origin));
    socket.push(message(7, "seven"));

    expect(gaps).toEqual([]);
    expect(heard).toEqual(["m1", "m2", "m3", "seven"]);
    expect(topic.lastSeq).toBe(7);
    expect(topic.gap).toBeNull();
  });

  test("own live broadcasts do not look like a gap, and do not hide a real one", async () => {
    const { topic, socket, gaps } = await listening();
    socket.push(message(1, "one"));

    // Sent while connected: the room gives it a sequence and never hands it
    // back to the socket that sent it.
    expect(topic.send("mine")).toBe(true);

    socket.push(message(3, "three"));
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(3);

    // The next jump is somebody else's missing message, not one of ours.
    socket.push(message(5, "five"));
    expect(gaps).toEqual([{ topic: TOPIC, expected: 4, received: 5 }]);
  });

  test("a reconnect that resumes where it left off reports no gap", async () => {
    const { sockets, topic, socket, heard, gaps } = await listening();
    socket.push(message(1, "one"));
    socket.push(message(2, "two"));

    // The socket drops; the client opens a new one and rejoins.
    socket.onclose?.({});
    for (let attempt = 0; attempt < 100 && sockets.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sockets.length).toBe(2);
    const second = await session(sockets, 1);
    expect(second.sent.filter((sent) => sent.type === "topic:join").at(-1)).toEqual({
      type: "topic:join",
      topic: TOPIC,
      since: 2,
    });

    // The replay overlaps by one, then continues without a hole.
    second.push(message(2, "two"));
    second.push(message(3, "three"));
    second.push({ type: "topic:joined", topic: TOPIC, seq: 3 });

    expect(heard).toEqual(["one", "two", "three"]);
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(3);
  });

  test("a reconnect whose replay window dropped messages reports exactly one gap", async () => {
    const { sockets, topic, socket, heard, gaps } = await listening();
    socket.push(message(1, "one"));
    socket.push(message(2, "two"));

    // Back after long enough that 3 and 4 fell out of the window: the replay
    // starts at 5, a jump of two.
    await session(sockets);
    socket.push(message(5, "five"));
    socket.push(message(6, "six"));
    socket.push(message(7, "seven"));
    socket.push({ type: "topic:joined", topic: TOPIC, seq: 7 });

    expect(gaps).toEqual([{ topic: TOPIC, expected: 3, received: 5 }]);
    expect(heard).toEqual(["one", "two", "five", "six", "seven"]);
    expect(topic.lastSeq).toBe(7);
  });

  test("a reconnect with nothing left to replay reports the gap from the join head", async () => {
    const { sockets, topic, socket, gaps } = await listening();
    socket.push(message(1, "one"));
    socket.push(message(2, "two"));

    // Everything after 2 is gone, so no frame arrives to carry the loss: the
    // join's own head is the only witness that messages were missed.
    await session(sockets);
    socket.push({ type: "topic:joined", topic: TOPIC, seq: 9 });

    expect(gaps).toEqual([{ topic: TOPIC, expected: 3, received: 9 }]);
    expect(topic.lastSeq).toBe(9);
  });

  test("a topic that restarts from scratch rewinds the position without a gap", async () => {
    const { topic, socket, gaps } = await listening();
    for (const seq of [1, 2, 3]) socket.push(message(seq, `m${seq}`));
    expect(topic.lastSeq).toBe(3);

    // A room rebuilt from empty counts from its own number, lower than ours.
    socket.push({ type: "topic:joined", topic: TOPIC, seq: 0 });
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(0);

    socket.push(message(1, "fresh"));
    expect(gaps).toEqual([]);
    expect(topic.lastSeq).toBe(1);
  });

  test("the gap survives until the topic is left, and leaving forgets it", async () => {
    const { socket, topic, gaps, stop } = await listening();
    socket.push(message(4, "four"));
    expect(gaps).toHaveLength(1);
    expect(topic.gap).toEqual({ topic: TOPIC, expected: 1, received: 4 });

    // New traffic does not erase the fact: it is a loss, not a state.
    socket.push(message(5, "five"));
    expect(topic.gap).toEqual({ topic: TOPIC, expected: 1, received: 4 });

    // The last listener leaving drops the topic's position; listening again
    // starts from the head the room reports.
    stop();
    expect(topic.lastSeq).toBeUndefined();
    expect(topic.gap).toBeNull();
    expect(socket.sent.filter((sent) => sent.type === "topic:leave")).toEqual([
      { type: "topic:leave", topic: TOPIC },
    ]);
  });
});
