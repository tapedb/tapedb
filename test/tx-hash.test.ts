/** The ops hash is stored in receipts and logs, so its digest must never change. */

import { describe, expect, test } from "bun:test";

import { opsHash, stableStringify } from "../src/engine/tx-hash";

/** 64-bit FNV-1a with BigInt, the reference. */
function reference(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("opsHash", () => {
  test("matches 64-bit FNV-1a, digests stored before stay valid", () => {
    // Digests written by the BigInt implementation.
    expect(opsHash([])).toBe("09612b07b5ecb5a5");
    expect(opsHash([{ op: "insert" }])).toBe("e314864e9b4cac51");
    const inputs: unknown[] = [
      [{ op: "insert", namespace: "task", id: "é😀\u0000", values: { n: 1, flag: true, none: null } }],
      Array.from({ length: 3000 }, (_, n) => ({ op: "patch", namespace: "task", id: `t${n}`, values: { title: `x${n}` } })),
    ];
    for (const ops of inputs) expect(opsHash(ops)).toBe(reference(stableStringify(ops)));
  });

  test("hashes a bulk write's ops without a BigInt step per byte", () => {
    const ops = Array.from({ length: 50_000 }, (_, n) => ({ op: "insert", namespace: "task", id: `t${n}`, values: { title: `bulk${n}` } }));
    const json = stableStringify(ops);
    let started = performance.now();
    reference(json);
    const bigint = performance.now() - started;
    started = performance.now();
    stableStringify(ops);
    const serialise = performance.now() - started;
    started = performance.now();
    opsHash(ops);
    const hashing = performance.now() - started - serialise;
    expect(hashing).toBeLessThan(bigint / 2);
  });
});
