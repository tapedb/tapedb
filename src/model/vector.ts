/**
 * A vector field's value, and the one codec for it: `f32le:v1:<base64>`.
 *
 * A stored embedding is a single string. JSON has no float32, so a JSON array
 * of numbers would lose the distinction between two JavaScript inputs that
 * round to the same bytes, and would cost the log far more than the bytes
 * themselves: against the real `LogWriter`, 768-dimension values in a JSON
 * array fit 15 rows in a log part where this encoding fits 60, and a 100-write
 * replay payload is 1,676,201 B against 432,804 B (−74%; −57% gzipped). At
 * 1,536 dimensions it is 7 rows against 31, and 3,351,173 B against 842,408 B.
 *
 * Because the string holds the exact bytes, a row is byte-identical through
 * SQLite, the transaction log, a snapshot, `$export` and backup NDJSON: every
 * one of those carries the string verbatim and none of them re-encodes it.
 *
 * The version is in the tag, so a later codec is a new tag rather than a
 * migration: `decodeVector` refuses a tag it does not know instead of guessing
 * what the bytes mean.
 *
 * Public input stays `number[]`. The write boundary validates the declared
 * length, converts to float32, refuses a value that is not finite *after* that
 * conversion, normalises `-0` to `+0`, refuses an all-zero vector and
 * serialises little-endian. Decoding happens only for the validation paths and
 * for whatever reads the bytes (the Vectorize binding, later), so every
 * existing JSON row pipeline is untouched.
 */

/** What every stored vector string starts with. */
export const VECTOR_TAG = "f32le:v1:";

/** Cloudflare Vectorize takes at most this many dimensions in float32. */
export const VECTOR_MAX_DIMENSIONS = 1_536;

/** A vector needs at least one dimension: an empty one has no direction. */
export const VECTOR_MIN_DIMENSIONS = 1;

const BYTES_PER_VALUE = 4;

/** The ceiling as the messages write it. */
const MAX_DIMENSIONS = VECTOR_MAX_DIMENSIONS.toLocaleString("en-US");

/**
 * A dimension count a schema may declare: an integer from 1 to 1,536.
 * Throws for anything else, including a missing one, so a mistake surfaces
 * where the schema is written rather than at the first write.
 */
export function assertVectorDimensions(dimensions: unknown): number {
  if (dimensions === undefined || dimensions === null) {
    throw new Error(
      `t.vector() needs { dimensions }: an integer from ${VECTOR_MIN_DIMENSIONS} to ${MAX_DIMENSIONS}.`
    );
  }
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions)) {
    throw new Error(
      `t.vector() takes an integer number of dimensions; ${JSON.stringify(dimensions)} is not one.`
    );
  }
  if (dimensions < VECTOR_MIN_DIMENSIONS || dimensions > VECTOR_MAX_DIMENSIONS) {
    throw new Error(
      `t.vector() takes ${VECTOR_MIN_DIMENSIONS} to ${MAX_DIMENSIONS} dimensions; ${dimensions} is outside that range.`
    );
  }
  return dimensions;
}

/**
 * The stored form of `values`: `f32le:v1:<base64>`.
 *
 * Every element must be a finite number that stays finite as float32, and at
 * least one must survive the conversion non-zero. A vector of values too small
 * for float32 is therefore refused here, after the conversion, rather than
 * passing a check on the inputs and then storing zeros.
 */
export function encodeVector(values: readonly number[], dimensions: number): string {
  const floats = toFloat32(values, dimensions);
  return `${VECTOR_TAG}${base64FromBytes(bytesOf(floats))}`;
}

/**
 * The values a stored vector string holds, as JavaScript numbers: exactly what
 * float32 can represent, so `encodeVector(decodeVector(text))` is `text`.
 *
 * `dimensions` is optional; when given, a string of another length is refused.
 */
export function decodeVector(text: string, dimensions?: number): number[] {
  if (typeof text !== "string") {
    throw new Error("must be a vector string, such as f32le:v1:<base64>.");
  }
  if (!text.startsWith(VECTOR_TAG)) {
    throw new Error(
      `is not a vector this build reads: it expects "${VECTOR_TAG}" and this value starts "${text.slice(0, 12)}".`
    );
  }
  const bytes = bytesFromBase64(text.slice(VECTOR_TAG.length));
  if (bytes.length % BYTES_PER_VALUE !== 0) {
    throw new Error(
      `holds ${bytes.length} bytes, which is not a whole number of float32 values.`
    );
  }
  const count = bytes.length / BYTES_PER_VALUE;
  if (dimensions !== undefined && count !== dimensions) {
    throw new Error(`holds ${count} values; the schema declares ${dimensions}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    out[index] = view.getFloat32(index * BYTES_PER_VALUE, true);
  }
  return out;
}

/**
 * The stored form of a value a write carries: a `number[]`, or a string this
 * codec wrote. A string is accepted only in its canonical form, so a replayed
 * log entry, an imported export and a fresh write all store the same bytes.
 */
export function canonicalVectorValue(value: unknown, dimensions: number): string {
  if (typeof value === "string") {
    const decoded = decodeVector(value, dimensions);
    const canonical = encodeVector(decoded, dimensions);
    if (canonical !== value) {
      throw new Error(
        "is not this codec's canonical form of its own values: send number[] or the string a read returned."
      );
    }
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error("must be an array of numbers, or the f32le:v1 string a read returned.");
  }
  return encodeVector(value, dimensions);
}

/** True for a string that carries this codec's tag, whatever its contents. */
export function isVectorString(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(VECTOR_TAG);
}

/**
 * The float32 values of `values`, checked: the declared length, a number in
 * every slot, finite as float32, `-0` normalised to `+0`, and not all zeros.
 */
function toFloat32(values: readonly number[], dimensions: number): Float32Array {
  if (!Array.isArray(values)) {
    throw new Error("must be an array of numbers.");
  }
  if (values.length !== dimensions) {
    throw new Error(
      `must hold exactly ${dimensions} values; it holds ${values.length}.`
    );
  }
  const floats = new Float32Array(dimensions);
  let nonZero = false;
  for (let index = 0; index < dimensions; index += 1) {
    const value = values[index];
    if (typeof value !== "number") {
      throw new Error(
        `must hold numbers; value ${index} is ${value === null ? "null" : typeof value}.`
      );
    }
    if (!Number.isFinite(value)) {
      throw new Error(`must hold finite numbers; value ${index} is ${String(value)}.`);
    }
    const float = Math.fround(value);
    if (!Number.isFinite(float)) {
      throw new Error(
        `must hold numbers that fit in float32; value ${index} is ${String(value)}, which overflows it.`
      );
    }
    // `-0` and `+0` compare equal, and this stores the canonical zero.
    floats[index] = float === 0 ? 0 : float;
    if (float !== 0) nonZero = true;
  }
  if (!nonZero) {
    throw new Error(
      `must hold at least one non-zero value; these are all zero as float32, so the vector has no direction.`
    );
  }
  return floats;
}

/** The little-endian bytes of a float32 vector. */
function bytesOf(floats: Float32Array): Uint8Array {
  const bytes = new Uint8Array(floats.length * BYTES_PER_VALUE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < floats.length; index += 1) {
    view.setFloat32(index * BYTES_PER_VALUE, floats[index]!, true);
  }
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  // 32 KiB at a time: `String.fromCharCode` takes the rest as arguments.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function bytesFromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new Error("is not base64 after its tag.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
