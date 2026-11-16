/**
 * Per-socket state of any size, and messages of any size.
 *
 * A socket's attachment survives hibernation but holds at most 16 KiB
 * (Cloudflare's limit), while its live queries, presence and topics have no
 * natural bound. While they are small they stay in the attachment, so a
 * cursor move costs no storage write. Past `INLINE_STATE_BYTES` they move to
 * `_socket_state` in parts, and the attachment keeps only who the socket is.
 *
 * Messages: Cloudflare closes a socket on a received frame over 32 MiB. The
 * client sends a larger message as `part` frames, which wait in
 * `_socket_parts` (so hibernation between frames loses nothing) until the
 * last arrives, then run as the whole message. Topic messages are relayed
 * part by part instead (see the room), so the room never holds one whole.
 *
 * Both tables are ephemeral, like the sockets they belong to: never logged,
 * snapshotted or exported, and cleared for sockets that are gone.
 */

import { MAX_SOCKET_MESSAGE_BYTES, MAX_SOCKET_PENDING_BYTES, MAX_ROOM_PENDING_BYTES, MAX_SOCKET_PENDING_MESSAGES, MAX_SOCKET_MESSAGE_PARTS } from "../socket-protocol";
import type { SqlExecutor } from "./tx-sql";
import type { SocketAttachment } from "./ws-types";

/** Attachment bytes kept inline; the platform allows 16 KiB. */
export const INLINE_STATE_BYTES = 12 * 1024;
/** Characters per stored part: 256 Ki UTF-16 units is at most 768 KiB of UTF-8. */
const STATE_PART_CHARS = 256 * 1024;

export class SocketLimitError extends Error {}

export const SOCKET_STATE_TABLE = "_socket_state";
export const SOCKET_PARTS_TABLE = "_socket_parts";

/** What stays in the attachment when the rest is stored. */
type CoreAttachment = Pick<SocketAttachment, "clientId" | "sub" | "role" | "exp"> & { spilled: true };

type Spillable = Omit<SocketAttachment, "clientId" | "sub" | "role" | "exp">;

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** Splits text into parts without cutting a surrogate pair. */
export function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.length > 0 ? parts : [""];
}

/** True when the stored attachment points at state kept in `_socket_state`. */
export function isSpilled(raw: unknown): raw is CoreAttachment {
  return typeof raw === "object" && raw !== null && (raw as { spilled?: unknown }).spilled === true;
}

/** The full attachment: inline as stored, or core plus the stored state. */
export function loadAttachment(sql: SqlExecutor, raw: unknown): unknown {
  if (!isSpilled(raw)) return raw;
  const rows = sql.all<{ data: string }>(
    `SELECT data FROM "${SOCKET_STATE_TABLE}" WHERE client_id = ? ORDER BY part`,
    raw.clientId
  );
  if (rows.length === 0) return null;
  const rest = JSON.parse(rows.map((row) => row.data).join("")) as Spillable;
  const { spilled: _spilled, ...core } = raw;
  return { ...core, ...rest };
}

/**
 * The value to hand `serializeAttachment`: the attachment itself when it
 * fits, or its core with the rest stored. Clears stored state it no longer
 * needs.
 */
export function storeAttachment(sql: SqlExecutor, attachment: SocketAttachment, wasSpilled: boolean): unknown {
  const size = byteLength(attachment);
  if (size > MAX_SOCKET_MESSAGE_BYTES) throw new SocketLimitError("Socket state exceeds its memory budget.");
  if (size <= INLINE_STATE_BYTES) {
    if (wasSpilled) sql.exec(`DELETE FROM "${SOCKET_STATE_TABLE}" WHERE client_id = ?`, attachment.clientId);
    return attachment;
  }
  const { clientId, sub, role, exp, ...rest } = attachment;
  sql.transactionSync(() => {
    sql.exec(`DELETE FROM "${SOCKET_STATE_TABLE}" WHERE client_id = ?`, clientId);
    splitText(JSON.stringify(rest), STATE_PART_CHARS).forEach((data, part) => {
      sql.exec(`INSERT INTO "${SOCKET_STATE_TABLE}" (client_id, part, data) VALUES (?, ?, ?)`, clientId, part, data);
    });
  });
  const core: CoreAttachment = { clientId, sub, role, exp, spilled: true };
  return core;
}

/**
 * Takes one part of a multi-frame message. Returns the whole message text
 * once the last part is in, null while more are expected, or an error code
 * for a part out of order (the parts so far are dropped).
 */
export function acceptPart(
  sql: SqlExecutor,
  clientId: string,
  part: { id: string; index: number; last: boolean; data: string },
  assemble = true
): { text: string } | { pending: true } | { complete: true } | { error: string } {
  const stored = sql.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ?`,
    clientId,
    part.id
  )?.n ?? 0;
  if (Number(stored) !== part.index) {
    sql.exec(`DELETE FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ?`, clientId, part.id);
    return { error: "part_out_of_order" };
  }
  const bytes = part.data.length > MAX_SOCKET_MESSAGE_BYTES ? MAX_SOCKET_MESSAGE_BYTES + 1 : encoder.encode(part.data).byteLength;
  const totals = sql.one<{ message: number; socket: number; room: number; messages: number }>(
    `SELECT COALESCE(SUM(CASE WHEN client_id = ? AND id = ? THEN length(CAST(data AS BLOB)) ELSE 0 END), 0) AS message,
            COALESCE(SUM(CASE WHEN client_id = ? THEN length(CAST(data AS BLOB)) + 128 ELSE 0 END), 0) AS socket,
            COALESCE(SUM(length(CAST(data AS BLOB)) + 128), 0) AS room,
            COUNT(DISTINCT CASE WHEN client_id = ? THEN id END) AS messages
       FROM "${SOCKET_PARTS_TABLE}"`, clientId, part.id, clientId, clientId
  )!;
  if (bytes + totals.message > MAX_SOCKET_MESSAGE_BYTES ||
      bytes + 128 + totals.socket > MAX_SOCKET_PENDING_BYTES ||
      bytes + 128 + totals.room > MAX_ROOM_PENDING_BYTES ||
      (stored === 0 && !part.last && totals.messages >= MAX_SOCKET_PENDING_MESSAGES) ||
      part.index >= MAX_SOCKET_MESSAGE_PARTS) {
    sql.exec(`DELETE FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ?`, clientId, part.id);
    return { error: "message_limit_exceeded" };
  }
  if (!part.last) {
    sql.exec(
      `INSERT INTO "${SOCKET_PARTS_TABLE}" (client_id, id, idx, data) VALUES (?, ?, ?, ?)`,
      clientId,
      part.id,
      part.index,
      part.data
    );
    return { pending: true };
  }
  if (!assemble) {
    sql.exec(`DELETE FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ?`, clientId, part.id);
    return { complete: true };
  }
  const earlier = sql.all<{ data: string }>(
    `SELECT data FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ? ORDER BY idx`,
    clientId,
    part.id
  );
  sql.exec(`DELETE FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ? AND id = ?`, clientId, part.id);
  return { text: earlier.map((row) => row.data).join("") + part.data };
}

/** Drops everything stored for one socket. */
export function forgetSocket(sql: SqlExecutor, clientId: string): void {
  sql.exec(`DELETE FROM "${SOCKET_STATE_TABLE}" WHERE client_id = ?`, clientId);
  sql.exec(`DELETE FROM "${SOCKET_PARTS_TABLE}" WHERE client_id = ?`, clientId);
}

/** Drops state of sockets that are gone (closed while the object was evicted). */
export function forgetOtherSockets(sql: SqlExecutor, live: readonly string[]): void {
  const keep = JSON.stringify(live);
  for (const table of [SOCKET_STATE_TABLE, SOCKET_PARTS_TABLE]) {
    sql.exec(`DELETE FROM "${table}" WHERE client_id NOT IN (SELECT value FROM json_each(?))`, keep);
  }
}
