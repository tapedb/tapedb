/**
 * Canonical hashing for transaction ops.
 *
 * Two retries of the same optimistic write may serialise their object keys in
 * a different order. `stableStringify` sorts object keys recursively so the
 * log hash (and therefore client transaction deduplication) is order
 * independent. Array order is preserved because it is semantic.
 *
 * The digest is synchronous on purpose: it runs inside `transactionSync`,
 * where the async WebCrypto API cannot be awaited. FNV-1a 64-bit is enough for
 * deduplication keys (it is not used for authentication).
 */


/** Stable JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  const serialised = serialise(value, new Set<object>());
  return serialised ?? "null";
}

/** Stable, order-independent digest of an ops array. */
export function opsHash(ops: unknown): string {
  return fnv1a64(stableStringify(ops));
}

function serialise(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      return JSON.stringify(value.toString());
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("Cannot serialise a circular structure.");
    }
    seen.add(value);
    const items = value.map((item) => serialise(item, seen) ?? "null");
    seen.delete(value);
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("Cannot serialise a circular structure.");
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const serialised = serialise(record[key], seen);
      if (serialised === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialised}`);
    }

    seen.delete(value);
    return `{${parts.join(",")}}`;
  }

  return undefined;
}

function fnv1a64(input: string): string {
  // 64-bit FNV-1a in four 16-bit limbs: the same digest as BigInt arithmetic,
  // without a BigInt multiply per byte (a bulk write hashes megabytes).
  const bytes = new TextEncoder().encode(input);
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let index = 0; index < bytes.length; index += 1) {
    h0 ^= bytes[index];
    // Multiply by the prime 2^40 + 0x1b3: 0x1b3 per limb, plus the 2^40 part
    // shifted into limbs 2 and 3.
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3;
    const t2 = h2 * 0x1b3 + (h0 << 8);
    const t3 = h3 * 0x1b3 + (h1 << 8);
    h1 = t1 + (t0 >>> 16);
    h0 = t0 & 0xffff;
    h2 = t2 + (h1 >>> 16);
    h1 &= 0xffff;
    h3 = (t3 + (h2 >>> 16)) & 0xffff;
    h2 &= 0xffff;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
}
