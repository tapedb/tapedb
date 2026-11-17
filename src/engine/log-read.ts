/**
 * Reading the transaction log back, newest first, for the studio's history
 * (GET /log). Admins and owners only, like a row's history.
 *
 * The log holds every value written, whatever the read rules say. So values
 * are shown only for models the caller may read in full: a read rule that is
 * a role level the caller meets. For a model with a filter or check read
 * rule, or one the caller's role cannot read, an op shows which row and which
 * fields, not the values. Personal fields never show a value.
 */

import type { RoleClaim } from "../claims";
import { NAMESPACES, toSnakeCase, type NamespaceDefinition } from "./registry";
import { fromStoredValue } from "./value-to-api";
import { logParts } from "./tx-log";
import { readsEveryRow } from "./tx-permissions";
import type { SqlExecutor, SqlValue } from "./tx-sql";

/** Ops listed per entry; past this, the entry says how many more there are. */
export const LOG_OPS_SHOWN = 100;
/** Ids listed per bulk op. */
const LOG_IDS_SHOWN = 20;
/** Entries a filtered page scans at most, so a rare model does not scan the whole log in one request. */
const LOG_SCAN = 1000;

export interface LogOp {
  op: string;
  namespace: string;
  id?: string;
  /** Bulk ops: the first ids, and how many there are. */
  ids?: string[];
  count?: number;
  /** Written values, when the caller may read every row of the model. */
  values?: Record<string, unknown>;
  /** Fields written whose values are not shown. */
  hidden?: string[];
  link?: string;
  targetId?: string;
  /** The values are the whole row after the write (logged that way with personal fields), not only what it set. */
  whole?: boolean;
}

export interface LogEntry {
  seq: number;
  at: number;
  /** The writer, with `audit: true`; otherwise null. */
  sub: string | null;
  role: number | null;
  /** Rows written, bulk ops counted per row. */
  rows: number;
  /** Rows written per model and op, over the whole transaction (listed ops or not). */
  counts: Record<string, Record<string, number>>;
  ops: LogOp[];
  /** Ops not listed (past LOG_OPS_SHOWN). */
  more: number;
}

interface LogRow extends Record<string, SqlValue> {
  seq: number;
  at: number;
  user_id: string | null;
  role: number | null;
  ops: string;
}

function byTable(table: string): NamespaceDefinition | undefined {
  return Object.values(NAMESPACES).find((namespace) => namespace.table === table);
}

/**
 * A workspace with personal fields logs each transaction as the rows it left
 * behind (`state:row`, `state:delete`, between `state:begin` and `state:end`),
 * in storage form. This turns one into an ordinary op: an insert when the row
 * was created by this write, an update otherwise, with its values in API form.
 */
function fromState(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.op === "state:begin" || raw.op === "state:end") return null;
  const namespace = byTable(String(raw.table ?? ""));
  if (!namespace) return null;
  if (raw.op === "state:delete") return { op: "delete", namespace: namespace.apiName, id: raw.id };
  const row = (raw.row ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const [name, attribute] of Object.entries(namespace.attributes)) {
    const column = toSnakeCase(name);
    if (column in row) values[name] = fromStoredValue(attribute.type, row[column] as never);
  }
  return { op: row.created_at === row.updated_at ? "insert" : "update", namespace: namespace.apiName, id: row.id, values, whole: true };
}

function shape(claim: RoleClaim, raw: Record<string, unknown>): LogOp {
  const namespace = String(raw.namespace ?? "");
  const out: LogOp = { op: String(raw.op), namespace };
  if (typeof raw.id === "string") out.id = raw.id;
  if (Array.isArray(raw.ids)) {
    out.ids = (raw.ids as string[]).slice(0, LOG_IDS_SHOWN);
    out.count = raw.ids.length;
  }
  if (typeof raw.link === "string") out.link = raw.link;
  if (typeof raw.targetId === "string") out.targetId = raw.targetId;
  if (raw.whole === true) out.whole = true;
  const written = { ...((raw.values as Record<string, unknown> | undefined) ?? {}), ...((raw.create as Record<string, unknown> | undefined) ?? {}) };
  const fields = Object.keys(written);
  if (fields.length > 0) {
    const attributes = NAMESPACES[namespace]?.attributes ?? {};
    const visible = readsEveryRow(claim, namespace);
    const values: Record<string, unknown> = {};
    const hidden: string[] = [];
    for (const field of fields) {
      if (visible && !attributes[field]?.personal) values[field] = written[field];
      else hidden.push(field);
    }
    if (Object.keys(values).length > 0) out.values = values;
    if (hidden.length > 0) out.hidden = hidden;
  }
  return out;
}

/**
 * Entries older than `before` (all when null), newest first. With `model`,
 * only entries that write it, and only its ops. `next` is where the following
 * page starts, or null at the start of the retained log.
 */
export function readLog(
  sql: SqlExecutor,
  claim: RoleClaim,
  options: { before: number | null; limit: number; model: string | null }
): { entries: LogEntry[]; next: number | null } {
  const entries: LogEntry[] = [];
  let cursor = options.before;
  let scanned = 0;
  for (;;) {
    const rows = sql.all<LogRow>(
      `SELECT seq, at, user_id, role, ops FROM "_tx_log" ${cursor === null ? "" : "WHERE seq < ?"} ORDER BY seq DESC LIMIT ?`,
      ...(cursor === null ? [] : [cursor]),
      Math.min(options.limit, 100)
    );
    if (rows.length === 0) return { entries, next: null };
    for (const row of rows) {
      const seq = Number(row.seq);
      cursor = seq;
      scanned++;
      const entry: LogEntry = { seq, at: Number(row.at), sub: row.user_id, role: row.role === null ? null : Number(row.role), rows: 0, counts: {}, ops: [], more: 0 };
      for (const part of logParts(sql, seq, row.ops)) {
        for (const stored of part as Array<Record<string, unknown>>) {
          const raw = typeof stored.op === "string" && stored.op.startsWith("state:") ? fromState(stored) : stored;
          if (raw === null) continue;
          if (options.model !== null && raw.namespace !== options.model) continue;
          const rows = Array.isArray(raw.ids) ? raw.ids.length : 1;
          entry.rows += rows;
          const byOp = (entry.counts[String(raw.namespace)] ??= {});
          byOp[String(raw.op)] = (byOp[String(raw.op)] ?? 0) + rows;
          if (entry.ops.length < LOG_OPS_SHOWN) entry.ops.push(shape(claim, raw));
          else entry.more++;
        }
      }
      // An entry with no ops is a marker (a restore's boundary); a filtered one that misses is skipped.
      if (entry.rows > 0) entries.push(entry);
      if (entries.length >= options.limit) return { entries, next: seq };
      if (options.model !== null && scanned >= LOG_SCAN) return { entries, next: seq };
    }
  }
}
