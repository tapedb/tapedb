/** Small serialisation helpers shared by the cache and outbox. */

/**
 * Deterministic JSON serialisation so two queries with the same shape share a
 * cache entry and subscription regardless of property order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Deep-clones JSON-shaped data. `structuredClone` is used when available; the
 * fallback covers older runtimes and test doubles.
 */
export function cloneJson<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON. Data from the engine is JSON-shaped.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
