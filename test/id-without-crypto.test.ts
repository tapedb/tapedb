/**
 * React Native has no Web Crypto, so `globalThis.crypto` is absent there and two
 * call sites used it unguarded: the app died on the first render.
 *
 * These cases remove the global and check the ids still work, which is the
 * mechanism that crash depended on.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { MemoryOutbox } from "../src/client/outbox";
import { id, isUuid, randomUuid } from "../src/client/id";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function withoutCrypto() {
  Object.defineProperty(globalThis, "crypto", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "crypto", original);
});

describe("ids on a runtime with no Web Crypto", () => {
  test("randomUuid still returns a UUID", () => {
    withoutCrypto();
    expect(globalThis.crypto).toBeUndefined();
    expect(isUuid(randomUuid())).toBe(true);
  });

  test("id still returns a UUID, and stays unique", () => {
    withoutCrypto();
    const first = id();
    const second = id();
    expect(isUuid(first)).toBe(true);
    expect(isUuid(second)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("constructing a client without Web Crypto", () => {
  // The crash was here, not in id.ts: `topicOrigin` was initialised with
  // `crypto.randomUUID()` as a field initialiser, so the app died before the
  // first render. A client must be constructible on a runtime with no crypto.
  const WORKSPACE = "11111111-1111-4111-8111-111111111111";

  test("createClient() does not throw when crypto is absent", () => {
    withoutCrypto();
    const appSchema = schema({ note: model({ title: t.string() }) });
    const db = createClient(
      {
        schema: appSchema,
        url: "http://engine.test",
        workspace: WORKSPACE,
        getToken: async () => "token",
      },
      {
        fetch: async () => new Response("{}", { status: 200 }),
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket in this test");
        },
      }
    );
    expect(db).toBeDefined();
    expect(typeof db.$flush).toBe("function");
  });
});
