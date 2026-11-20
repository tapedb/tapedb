/**
 * Client-generated entity ids.
 *
 * UUIDv7 keeps the timestamp prefix so ids sort roughly with creation time,
 * which matches the engine's client-generated id contract. When
 * `crypto.getRandomValues` is unavailable we fall back to `crypto.randomUUID`
 * (UUIDv4), and finally to a Math.random-based UUID.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function randomBytes(length: number): Uint8Array | null {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(length));
  }
  return null;
}

function formatUuid(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fallbackId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** Last timestamp and 12-bit counter handed out, for monotonic ids. */
let lastMs = -1;
let counter = 0;

/**
 * Returns a UUIDv7 (or a random UUID when the platform cannot do better).
 *
 * Ids from one client sort in the order they were made, even within one
 * millisecond: the 12 bits after the version carry a counter (RFC 9562,
 * method 1), seeded randomly in the lower half each millisecond so there is
 * room to count up. When the counter runs out the timestamp moves forward by
 * one, which keeps order at the cost of a millisecond of drift.
 */
export function id(): string {
  const random = randomBytes(10);
  if (!random) return fallbackId();

  const bytes = new Uint8Array(16);
  let now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = ((random[0]! << 8) | random[1]!) & 0x7ff;
  } else {
    now = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      now = lastMs;
      counter = 0;
    }
  }

  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes.set(random, 6);

  // Version 7, the counter in rand_a, then the RFC 4122 variant.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/**
 * A random UUID, for values that only need to be unique rather than ordered
 * (a socket's id, a topic's origin). Some JavaScript runtimes ship no `crypto`,
 * so this never touches it unguarded — the same fallback chain as `id()`,
 * without the timestamp.
 */
export function randomUuid(): string {
  return fallbackId();
}

/** Test helper: true when the value is a syntactically valid UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
