/**
 * Workspace export: every row the caller may read, as NDJSON.
 *
 *   {"type":"header","format":"tapedb-export","version":1,"workspaceId":…,"seq":…,"models":[…],"skipped":[…]}
 *   {"type":"row","model":"task","data":{…}}              one per row, model by model, in id order
 *   {"type":"file","file":{"path":…,"size":…,…}}          the file index (bytes stay in R2)
 *   {"type":"end","seq":…,"rows":…,"counts":{…},"consistent":true}
 *
 * Rows go through the same query path as any read, so read rules apply, a
 * model the caller cannot read is skipped and named in the header, and rows
 * come back in the API shape a client would see.
 *
 * The stream is pulled: each pull reads one chunk of up to 1000 rows, keyset
 * by id, so a large workspace never sits in memory at once. Writes are not
 * held off for the length of an export, so one can land between chunks; the
 * end line reports the sequence at the start and at the end, and
 * `consistent` is true when no write landed in between: the export is then
 * exactly the workspace at that sequence. An export that stops early ends
 * with an `error` line and no `end`.
 */

import type { RoleClaim } from "../claims";
import { compileQuery } from "./query-compile";
import { authorizeQuery, executeCompiledQueryWithPageInfo, viewAccess } from "./query-execute";
import { QUERY_CHUNK_ROWS } from "./query-types";
import { ENGINE_TABLES, NAMESPACES } from "./registry";
import type { SqlExecutor } from "./tx-sql";
import { TxError } from "./tx-types";

export const EXPORT_FORMAT = "tapedb-export";
export const EXPORT_VERSION = 1;

function highWater(sql: SqlExecutor): number {
  const row = sql.one<{ seq: number | null }>(`SELECT high_water_seq AS "seq" FROM "_tx_state" WHERE "id" = 1`);
  return Number(row?.seq ?? 0);
}

function schemaVersion(sql: SqlExecutor): string | null {
  const row = sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`);
  return row?.value ?? null;
}

/** The readable models, in registry order, and the ones the caller may not read. */
function plan(claim: RoleClaim): { models: string[]; skipped: Array<{ model: string; reason: string }> } {
  const models: string[] = [];
  const skipped: Array<{ model: string; reason: string }> = [];
  for (const apiName of Object.keys(NAMESPACES)) {
    try {
      authorizeQuery(claim, compileQuery({ [apiName]: { $: { limit: 1 } } }, viewAccess(claim)));
      models.push(apiName);
    } catch (error) {
      skipped.push({ model: apiName, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { models, skipped };
}

/**
 * Lines of the export, produced lazily. Each `next()` reads at most one
 * chunk from SQLite.
 */
export function* exportLines(
  sql: SqlExecutor,
  claim: RoleClaim,
  workspaceId: string,
  now: () => number = Date.now
): Generator<string> {
  const startSeq = highWater(sql);
  const { models, skipped } = plan(claim);
  yield JSON.stringify({
    type: "header",
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    workspaceId,
    seq: startSeq,
    exportedAt: now(),
    schemaVersion: schemaVersion(sql),
    models,
    skipped,
  });

  const counts: Record<string, number> = {};
  let rows = 0;
  try {
    for (const model of models) {
      counts[model] = 0;
      let after: string | undefined;
      for (;;) {
        const compiled = compileQuery(
          {
            [model]: {
              $: { order: { id: "asc" }, limit: QUERY_CHUNK_ROWS, ...(after === undefined ? {} : { after }) },
            },
          },
          viewAccess(claim)
        );
        const { data, pageInfo } = executeCompiledQueryWithPageInfo(sql, compiled, claim);
        for (const row of data[model] ?? []) {
          yield JSON.stringify({ type: "row", model, data: row });
          counts[model] += 1;
          rows += 1;
        }
        const next = pageInfo[model]?.nextCursor;
        if (pageInfo[model]?.hasMore !== true || next === undefined) break;
        after = next;
      }
    }

    let lastPath: string | null = null;
    for (;;) {
      const files: Array<Record<string, string | number | null>> = sql.all<Record<string, string | number | null>>(
        `SELECT "id", "path", "r2_key" AS "r2Key", "size", "content_type" AS "contentType",
                "created_at" AS "createdAt", "updated_at" AS "updatedAt"
           FROM "${ENGINE_TABLES.files}"
          ${lastPath === null ? "" : `WHERE "path" > ?`}
          ORDER BY "path" LIMIT ?`,
        ...((lastPath === null ? [] : [lastPath]) as string[]),
        QUERY_CHUNK_ROWS
      );
      for (const file of files) yield JSON.stringify({ type: "file", file });
      if (files.length < QUERY_CHUNK_ROWS) break;
      lastPath = String(files[files.length - 1].path);
    }
  } catch (error) {
    yield JSON.stringify({
      type: "error",
      code: error instanceof TxError ? error.code : "storage_error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const endSeq = highWater(sql);
  yield JSON.stringify({
    type: "end",
    startSeq,
    seq: endSeq,
    rows,
    counts,
    consistent: endSeq === startSeq,
  });
}

/** The export as a byte stream that reads one chunk per pull. */
export function exportStream(
  sql: SqlExecutor,
  claim: RoleClaim,
  workspaceId: string
): ReadableStream<Uint8Array> {
  const lines = exportLines(sql, claim, workspaceId);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // A few lines per pull keeps the stream moving without reading ahead
      // more than one chunk of rows.
      let text = "";
      for (let count = 0; count < 256; count += 1) {
        const next = lines.next();
        if (next.done) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
          return;
        }
        text += next.value + "\n";
      }
      controller.enqueue(encoder.encode(text));
    },
    cancel() {
      lines.return(undefined);
    },
  });
}
