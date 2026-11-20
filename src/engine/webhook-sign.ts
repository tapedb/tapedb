/**
 * Signing an outbound webhook.
 *
 * Every delivery attempt carries `X-Tapedb-Signature: t=<unix-seconds>,v1=<hex>`
 * where `<hex>` is HMAC-SHA256 over `` `${t}.${body}` `` with the endpoint's
 * secret, and `body` is the exact bytes posted (the JSON text, byte for byte —
 * never a re-serialisation of a parsed object).
 *
 * The timestamp is part of the signed string so a consumer can reject an old
 * signature and refuse a replay; it is the attempt's time, not the event's, so
 * a retry carries a fresh signature over the same body. Comparing the two MACs
 * in constant time is the consumer's job: this module only signs.
 */

/** Header a consumer reads the signature from. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Tapedb-Signature";

/**
 * How far a consumer's clock may drift from the signed timestamp, in seconds.
 * Exported for consumers to compare against; delivery does not use it.
 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

/** Imported HMAC keys, kept per secret: a delivery loop signs many events. */
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  const known = keys.get(secret);
  if (known !== undefined) return known;
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  keys.set(secret, key);
  return key;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The header value for one attempt: `t=<unix seconds>,v1=<hex>` over
 * `` `${timestamp}.${body}` ``.
 */
export async function webhookSignature(
  secret: string,
  timestamp: number,
  body: string
): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret), encoder.encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${hex(signature)}`;
}
