/**
 * How the WebSocket upgrade carries the role claim. Browsers cannot set an
 * `Authorization` header on an upgrade, so the client offers two subprotocols:
 * `tapedb`, which the room selects, and `tapedb.claim.<jwt>`, which carries
 * the token. A JWT's characters are all valid in a protocol token. Unlike a
 * query parameter, a header does not end up in URLs, request logs or the
 * browser's history.
 */
export const SOCKET_PROTOCOL = "tapedb";
export const CLAIM_PROTOCOL_PREFIX = "tapedb.claim.";

/** The subprotocols a client offers for `token`. */
export function socketProtocols(token: string): string[] {
  return [SOCKET_PROTOCOL, `${CLAIM_PROTOCOL_PREFIX}${token}`];
}

/** The offered subprotocols in a `Sec-WebSocket-Protocol` header. */
export function offeredProtocols(header: string | null): string[] {
  if (header === null) return [];
  return header.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The claim token carried in the offered subprotocols, if any. */
export function claimFromProtocols(header: string | null): string | null {
  const entry = offeredProtocols(header).find((part) => part.startsWith(CLAIM_PROTOCOL_PREFIX));
  const token = entry?.slice(CLAIM_PROTOCOL_PREFIX.length) ?? "";
  return token.length > 0 ? token : null;
}

/** Bounds complete JSON messages assembled in memory, including broadcasts. */
export const MAX_SOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SOCKET_PENDING_BYTES = 8 * 1024 * 1024;
export const MAX_ROOM_PENDING_BYTES = 32 * 1024 * 1024;
export const MAX_SOCKET_PENDING_MESSAGES = 8;
export const MAX_SOCKET_MESSAGE_PARTS = 1024;
