/**
 * A vector field's value: `f32le:v1:<base64>`.
 *
 * The encoding is the decision this test file defends. The stored form is one
 * string of little-endian float32 values, so a row survives SQLite, the log, a
 * snapshot, `$export` and backup NDJSON byte for byte, and two JavaScript
 * inputs that round to the same float32 store the same bytes. A later codec is
 * a new tag, never a migration, so an unknown tag is refused rather than
 * guessed at.
 */
import { describe, expect, test } from "bun:test";

import {
  decodeVector,
  encodeVector,
  model,
  schema,
  t,
  VECTOR_MAX_DIMENSIONS,
  VECTOR_TAG,
} from "../src/schema";
import { canonicalVectorValue } from "../src/model/vector";

/** A refusal, with the message a caller sees. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal, and the call returned");
}

/** The bytes a float32 value has, little-endian, as an independent check. */
function littleEndian(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

describe("t.vector({ dimensions })", () => {
  test("refuses a dimension count outside 1 to 1,536, and one that is not an integer", () => {
    expect(refusal(() => t.vector({ dimensions: 0 }))).toContain("1 to 1,536");
    expect(refusal(() => t.vector({ dimensions: -1 }))).toContain("1 to 1,536");
    expect(refusal(() => t.vector({ dimensions: VECTOR_MAX_DIMENSIONS + 1 }))).toContain("1537 is outside");
    expect(refusal(() => t.vector({ dimensions: 1.5 }))).toContain("integer");
    expect(refusal(() => t.vector({ dimensions: Number.NaN }))).toContain("integer");
    expect(refusal(() => t.vector({ dimensions: Number.POSITIVE_INFINITY }))).toContain("integer");
    expect(refusal(() => t.vector({ dimensions: "768" as never }))).toContain("integer");
    expect(refusal(() => t.vector({} as never))).toContain("dimensions");
    expect(refusal(() => t.vector(undefined as never))).toContain("dimensions");
  });

  test("accepts the ends of the range", () => {
    expect(t.vector({ dimensions: 1 }).dimensions).toBe(1);
    expect(t.vector({ dimensions: VECTOR_MAX_DIMENSIONS }).dimensions).toBe(VECTOR_MAX_DIMENSIONS);
  });

  test("composes with .optional() like every other kind", () => {
    const required = t.vector({ dimensions: 8 });
    const optional = required.optional();
    expect(optional.isOptional).toBe(true);
    expect(optional.dimensions).toBe(8);
    // The base builder is untouched: builders are immutable.
    expect(required.isOptional).toBe(false);
  });

  test("refuses a default, an index and uniqueness", () => {
    const field = t.vector({ dimensions: 8 });
    // A default embedding is meaningless for every row, and the builder's own
    // type already refuses one; this is the runtime refusal behind it.
    const withDefault = field as unknown as { default(value: number[]): unknown };
    expect(refusal(() => withDefault.default([1, 2, 3, 4, 5, 6, 7, 8]))).toContain("default");
    expect(refusal(() => (field as unknown as { index(): unknown }).index())).toContain("indexed");
    expect(refusal(() => (field as unknown as { unique(): unknown }).unique())).toContain("unique");
  });

  test("the schema gives the field a TEXT column and keeps it out of filters", () => {
    const compiled = schema({
      note: model({ title: t.string(), embedding: t.vector({ dimensions: 4 }).optional() }),
    });
    expect(compiled.registry.namespaces[0]!.attributes.embedding).toEqual({
      type: "vector",
      optional: true,
      dimensions: 4,
    });
    expect(compiled.migrations.at(-1)!.sql).toContain('"embedding" TEXT');
    expect(compiled.graph.note!.filterable.has("embedding")).toBe(false);
    expect(compiled.graph.note!.scalars.embedding).toEqual({
      kind: "vector",
      optional: true,
      hasDefault: false,
      defaultValue: undefined,
      dimensions: 4,
    });
  });
});

describe("the codec", () => {
  test("a vector becomes little-endian float32 base64", () => {
    expect(encodeVector([1, -2.5], 2)).toBe(`${VECTOR_TAG}AACAPwAAIMA=`);
    // Checked against Node's own writer, not against this implementation.
    expect(encodeVector([1, -2.5], 2).slice(VECTOR_TAG.length)).toBe(littleEndian([1, -2.5]).toString("base64"));
    expect(encodeVector([0.5], 1)).toBe(`${VECTOR_TAG}AAAAPw==`);
  });

  test("the bytes really are little-endian", () => {
    // The same value written big-endian is a different string, and decodes to
    // a different number: the codec does not accept either byte order.
    const bigEndian = Buffer.alloc(4);
    bigEndian.writeFloatBE(1, 0);
    expect(encodeVector([1], 1)).not.toBe(`${VECTOR_TAG}${bigEndian.toString("base64")}`);
    expect(decodeVector(`${VECTOR_TAG}${bigEndian.toString("base64")}`, 1)[0]).not.toBe(1);
  });

  test("decode returns the float32 values, and re-encoding gives the same string", () => {
    const values = [0.1, 0.2, -0.3, 1 / 3, 1e-8, 1e8];
    const text = encodeVector(values, values.length);
    const decoded = decodeVector(text);
    expect(decoded).toEqual(values.map((value) => Math.fround(value)));
    expect(decoded[0]).not.toBe(0.1);
    expect(encodeVector(decoded, values.length)).toBe(text);
  });

  test("768 and 1,536 dimensions round-trip", () => {
    for (const dimensions of [768, VECTOR_MAX_DIMENSIONS]) {
      const values = Array.from({ length: dimensions }, (_, index) => Math.sin(index));
      const text = encodeVector(values, dimensions);
      expect(decodeVector(text, dimensions)).toEqual(values.map((value) => Math.fround(value)));
      // Base64 of 4 bytes per dimension, padded: no line breaks, no wrapping.
      expect(text).toMatch(/^f32le:v1:[A-Za-z0-9+/]+={0,2}$/);
      expect(text.length).toBe(VECTOR_TAG.length + Math.ceil((dimensions * 4) / 3) * 4);
    }
  });

  test("a length that is not the declared one is refused", () => {
    expect(refusal(() => encodeVector([1, 2, 3], 4))).toContain("exactly 4 values; it holds 3");
    expect(refusal(() => encodeVector([1, 2], 1))).toContain("exactly 1 values; it holds 2");
    expect(refusal(() => encodeVector([], 1))).toContain("exactly 1 values; it holds 0");
    expect(refusal(() => decodeVector(encodeVector([1, 2], 2), 3))).toContain("holds 2 values; the schema declares 3");
  });

  test("an element that is not a finite number is refused", () => {
    expect(refusal(() => encodeVector([Number.NaN, 1], 2))).toContain("finite numbers; value 0 is NaN");
    expect(refusal(() => encodeVector([1, Number.POSITIVE_INFINITY], 2))).toContain("value 1 is Infinity");
    expect(refusal(() => encodeVector([Number.NEGATIVE_INFINITY, 1], 2))).toContain("-Infinity");
    expect(refusal(() => encodeVector([1, "2" as never], 2))).toContain("value 1 is string");
    expect(refusal(() => encodeVector([1, null as never], 2))).toContain("value 1 is null");
  });

  test("a value that overflows float32 is refused", () => {
    // 1e39 is a finite JavaScript number and an infinity as float32.
    expect(Number.isFinite(1e39)).toBe(true);
    expect(refusal(() => encodeVector([1e39, 1], 2))).toContain("overflows");
    expect(refusal(() => encodeVector([-1e39, 1], 2))).toContain("overflows");
  });

  test("an all-zero vector is refused", () => {
    expect(refusal(() => encodeVector([0, 0, 0], 3))).toContain("at least one non-zero");
  });

  test("tiny values that round to zero are an all-zero vector, not a near-zero one", () => {
    // Each element is a real, non-zero JavaScript number, and every one of
    // them is 0 as float32: the check has to run after the conversion.
    const tiny = [1e-50, -1e-50, 2e-46];
    expect(tiny.every((value) => value !== 0)).toBe(true);
    expect(tiny.every((value) => Math.fround(value) === 0)).toBe(true);
    expect(refusal(() => encodeVector(tiny, 3))).toContain("all zero as float32");
    // One value that survives makes it a vector again.
    expect(decodeVector(encodeVector([...tiny, 1], 4))[3]).toBe(1);
  });

  test("-0 is stored as +0", () => {
    const text = encodeVector([-0, 1], 2);
    expect(text).toBe(encodeVector([0, 1], 2));
    const decoded = decodeVector(text);
    expect(Object.is(decoded[0], -0)).toBe(false);
    expect(Object.is(decoded[0], 0)).toBe(true);
    // The stored bytes have no sign bit set.
    expect(text).toBe(`${VECTOR_TAG}${littleEndian([0, 1]).toString("base64")}`);
  });

  test("decode refuses an unknown tag rather than guessing", () => {
    expect(refusal(() => decodeVector("f32le:v2:AACAPw=="))).toContain("is not a vector this build reads");
    expect(refusal(() => decodeVector("json:[1,2]"))).toContain("is not a vector this build reads");
    expect(refusal(() => decodeVector("AACAPw=="))).toContain("is not a vector this build reads");
    expect(refusal(() => decodeVector(42 as never))).toContain("must be a vector string");
  });

  test("decode refuses a tagged value that is not base64, or not whole float32 values", () => {
    expect(refusal(() => decodeVector(`${VECTOR_TAG}not base64!`))).toContain("not base64");
    // Three bytes: half a float32.
    expect(refusal(() => decodeVector(`${VECTOR_TAG}${Buffer.from([1, 2, 3]).toString("base64")}`))).toContain(
      "not a whole number of float32 values"
    );
  });

  test("a write takes number[], or the string a read returned, and nothing else", () => {
    const text = encodeVector([1, 2], 2);
    expect(canonicalVectorValue([1, 2], 2)).toBe(text);
    expect(canonicalVectorValue(text, 2)).toBe(text);
    expect(refusal(() => canonicalVectorValue("f32le:v2:AACAPw==", 2))).toContain("is not a vector this build reads");
    expect(refusal(() => canonicalVectorValue(text, 3))).toContain("the schema declares 3");
    expect(refusal(() => canonicalVectorValue({ 0: 1, 1: 2 }, 2))).toContain("must be an array of numbers");
    expect(refusal(() => canonicalVectorValue(encodeVector([0, 0], 2).replace("AA==", "AA=="), 2))).toContain("at least one non-zero");
    // A string that decodes but is not what this codec writes is refused.
    expect(refusal(() => canonicalVectorValue(`${VECTOR_TAG}AACAPw`, 1))).toContain("canonical form");
  });
});
