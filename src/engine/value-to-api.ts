import type { AttributeType } from "./registry";
import type { SqlValue } from "./tx-sql";

/** Converts a stored value to the API shape for its registry type. */
export function fromStoredValue(
  type: AttributeType,
  value: SqlValue | undefined
): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      return value !== 0;
    case "date":
      return toEpochMilliseconds(value);
    case "json":
    case "any":
      return typeof value === "string" ? parseJson(value) : value;
    case "vector":
      // The stored string, exactly as written: `f32le:v1:<base64>`. Decoding
      // is the codec's job, and only for the validation paths and whatever
      // reads the bytes.
      return typeof value === "string" ? value : null;
  }
}

function toEpochMilliseconds(value: SqlValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Stored JSON should be valid; keep the request alive if it is not.
    return value;
  }
}

