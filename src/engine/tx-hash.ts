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

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

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
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(input);

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  return hash.toString(16).padStart(16, "0");
}
