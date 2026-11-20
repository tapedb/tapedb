/**
 * The per-row digest: what the index is supposed to hold for one row.
 *
 * A digest answers one question — "is the vector in the index still the one
 * this row has?" — and it must answer it for a filter change too, not only for
 * a vector change. A metadata filter is evaluated at the provider, before the
 * ranking, so a row whose `archived` flag flipped to `true` but whose embedding
 * did not move is still returned by `{ archived: false }` and then dropped by
 * the version gate: the row becomes unsearchable while the index thinks it is
 * current. Hashing the filter values together with the vector is what makes
 * that write re-publish.
 *
 * What is hashed, in order, joined by U+001F, encoded UTF-8, SHA-256, lowercase
 * hex (64 ASCII characters — the provider truncates indexed strings at 64
 * bytes, so the digest fits the metadata index exactly):
 *
 *   1. `tapedb.vector.digest/1` — the digest's own version, so a later rule is
 *      a new string rather than a silent reinterpretation of old digests;
 *   2. the codec tag, e.g. `f32le:v1:` — a value written by a different codec
 *      is a different state even if it decodes to the same numbers;
 *   3. the model's API name and the row ID;
 *   4. the **decoded canonical bytes** of the vector, as base64: the stored
 *      string is decoded and re-encoded through the one codec before hashing,
 *      so two JavaScript inputs that round to the same float32 (`0.1` and its
 *      nearest float32) produce one digest, and `-0` and `+0` produce one;
 *   5. the filter values, sorted by attribute name, each as
 *      `<name>` U+001E `<typed value>`, where a boolean is `b0`/`b1`, a number
 *      is `n:<JSON>`, a string is `s:<JSON>` and an absent value is `absent`.
 *
 * A digest is a comparison key, not a MAC: it decides whether to publish, and
 * the search path re-reads the row and re-applies its rules regardless.
 */

import { decodeVector, encodeVector, VECTOR_TAG } from "../../model/vector";

/** The digest rule's version, part of the hashed string. */
export const VECTOR_DIGEST_VERSION = 1;

/** The codec this build writes; a digest records it in its preimage. */
export const VECTOR_DIGEST_CODEC = VECTOR_TAG;

/** A filter value as a stored column holds it, or absent. */
export type VectorFilterValue = string | number | boolean | null | undefined;

export interface VectorDigestInput {
  /** The model's API name. */
  model: string;
  rowId: string;
  /** The stored `f32le:v1:<base64>` string, exactly as SQLite holds it. */
  vector: string;
  /** The attribute's declared dimensions; a value of another length throws. */
  dimensions: number;
  /** Filter attribute (API name) to stored value. */
  filters: Readonly<Record<string, VectorFilterValue>>;
}

const SEPARATOR = "\u001f";
const NAME_VALUE = "\u001e";

/**
 * The exact bytes a digest hashes. Exported so a test can assert the rule
 * rather than only its stability, and so a reconciliation job can recompute a
 * digest the same way.
 */
export function vectorDigestPreimage(input: VectorDigestInput): string {
  // Decoding and re-encoding is what makes the hash cover the canonical bytes:
  // the write path already stores canonical form, and this refuses a value that
  // is not (wrong length, unknown tag) instead of hashing something unreadable.
  const canonical = encodeVector(decodeVector(input.vector, input.dimensions), input.dimensions);
  const payload = canonical.slice(VECTOR_DIGEST_CODEC.length);

  const filters = Object.keys(input.filters)
    .sort()
    .map((name) => `${name}${NAME_VALUE}${encodeFilterValue(input.filters[name])}`);

  return [
    `tapedb.vector.digest/${VECTOR_DIGEST_VERSION}`,
    VECTOR_DIGEST_CODEC,
    input.model,
    input.rowId,
    payload,
    ...filters,
  ].join(SEPARATOR);
}

/** SHA-256 of the preimage, lowercase hex: 64 characters. */
export async function vectorRowDigest(input: VectorDigestInput): Promise<string> {
  return sha256Hex(vectorDigestPreimage(input));
}

/** How one filter value contributes to the digest. */
export function encodeFilterValue(value: VectorFilterValue): string {
  if (value === null || value === undefined) return "absent";
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") return `n:${JSON.stringify(value)}`;
  return `s:${JSON.stringify(value)}`;
}

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
