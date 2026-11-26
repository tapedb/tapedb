import { ENGINE_MIGRATIONS } from "../../src/engine/migrations-bundle";
import { readdirSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

// The durability executor's shape (a cursor per `exec`), which is what
// `createSqlExecutor` below returns. This used to import from "./sql", a file
// that does not exist here; a type-only import is erased before bun runs, so
// the suite never noticed and neither did `typecheck`, which did not cover
// this directory.
import type { SqlExecutor, SqlValue } from "../../src/engine/durability/sql";

/**
 * Test-only adapter that gives `bun:sqlite` the same tiny `exec` surface as
 * `DurableObjectStorage.sql`.
 */
export function createSqlExecutor(db: Database): SqlExecutor {
  return {
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ) {
      const trimmed = query.trim();
      const isRead = /^(select|with|pragma|explain)\b/i.test(trimmed);
      let rows: T[] = [];

      if (isRead) {
        rows = db.query(query).all(...(bindings as never[])) as T[];
      } else if (bindings.length > 0) {
        db.query(query).run(...(bindings as never[]));
      } else {
        db.exec(query);
      }

      return {
        toArray: () => rows,
        one: () => {
          if (rows.length === 0) {
            throw new Error("Query returned no rows.");
          }
          return rows[0];
        },
      };
    },
  };
}

const MIGRATIONS_DIR = new URL(
  "./migrations/",
  import.meta.url
);

/** Apply every workspace migration in order so 0002+ needs no test changes. */
const SCHEMA_SQL = [
  ...readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(new URL(file, MIGRATIONS_DIR), "utf8")),
  // The engine track runs after the baseline; the fixture's app migrations
  // never touch the tables it changes, so appending it is equivalent.
  ...ENGINE_MIGRATIONS.map((migration) => migration.sql),
].join("\n");

export function openTestDb(): { db: Database; sql: SqlExecutor } {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return { db, sql: createSqlExecutor(db) };
}

export const TEST_WORKSPACE = "0190a5b2-7c3d-7e8f-9a0b-1c2d3e4f5a6b";

export interface TxLogFixture {
  seq: number;
  ops: unknown;
  clientTxId?: string | null;
  userId?: string | null;
  role?: number | null;
  at?: number;
  schemaVersion?: string;
}

export function insertTxLog(sql: SqlExecutor, fixture: TxLogFixture): void {
  sql.exec(
    `INSERT INTO "_tx_log"
       (seq, client_tx_id, ops, ops_hash, user_id, role, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fixture.seq,
    fixture.clientTxId ?? null,
    JSON.stringify(fixture.ops),
    `hash-${fixture.seq}`,
    fixture.userId ?? null,
    fixture.role ?? null,
    fixture.at ?? 1_000 + fixture.seq,
    fixture.schemaVersion ?? "0001_baseline"
  );
}

export function setHighWater(sql: SqlExecutor, seq: number): void {
  sql.exec(`UPDATE "_tx_state" SET high_water_seq = ? WHERE id = 1`, seq);
}

export function setFlushSeq(sql: SqlExecutor, seq: number): void {
  sql.exec(
    `UPDATE "_flush_state"
        SET last_seq = ?, updated_at = ?
      WHERE id = 1`,
    seq,
    seq
  );
}

export function insertFolder(sql: SqlExecutor, id: string, name: string): void {
  sql.exec(
    `INSERT INTO "folders" (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    id,
    name,
    1,
    1
  );
}

interface StoredObject {
  body: Uint8Array;
  etag: string;
  contentType?: string;
  uploaded: number;
}

type PutOutcome = void | "conflict";

/**
 * Minimal in-memory R2 with the ETag semantics `putManifest` depends on.
 */
export class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  readonly puts: Array<{ key: string; options: unknown }> = [];
  failPuts = false;
  failDeletes = false;
  beforePut?: (
    key: string,
    options: unknown,
    current: StoredObject | undefined
  ) => PutOutcome;

  /** The time new objects record as `uploaded`. */
  clock = 0;

  private etagCounter = 0;

  seed(key: string, body: string, uploaded = this.clock): void {
    this.objects.set(key, {
      body: new TextEncoder().encode(body),
      etag: this.nextEtag(),
      uploaded,
    });
  }

  async put(
    key: string,
    value: unknown,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
      httpMetadata?: { contentType?: string };
    }
  ): Promise<unknown> {
    if (this.failPuts) {
      throw new Error("R2 write failed.");
    }

    const current = this.objects.get(key);
    const onlyIf = options?.onlyIf;

    if (onlyIf?.etagMatches !== undefined) {
      if (!current || current.etag !== onlyIf.etagMatches) return null;
    }

    if (onlyIf?.etagDoesNotMatch !== undefined) {
      if (onlyIf.etagDoesNotMatch === "*") {
        if (current) return null;
      } else if (current && current.etag === onlyIf.etagDoesNotMatch) {
        return null;
      }
    }

    if (value instanceof ReadableStream) value = await new Response(value).arrayBuffer();
    const outcome = this.beforePut?.(key, options, current);
    if (outcome === "conflict") {
      if (current) current.etag = this.nextEtag();
      return null;
    }

    const body = await toBytes(value);
    const stored: StoredObject = {
      body,
      etag: this.nextEtag(),
      contentType: options?.httpMetadata?.contentType,
      uploaded: this.clock,
    };
    this.objects.set(key, stored);
    this.puts.push({ key, options });

    return this.objectFor(key);
  }

  /**
   * Like R2: an upload is resumable by id; parts are joined in part-number
   * order on complete, and nothing is visible before. Complete enforces R2's
   * rules: every part but the last at least 5 MiB, and all of them the same size.
   */
  private readonly uploads = new Map<string, { key: string; contentType?: string; parts: Map<number, Uint8Array> }>();

  async createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }) {
    if (this.failPuts) throw new Error("R2 write failed.");
    this.multipartUploads += 1;
    const uploadId = `upload-${this.multipartUploads}`;
    this.uploads.set(uploadId, { key, contentType: options?.httpMetadata?.contentType, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const find = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
      return upload;
    };
    return {
      uploadId,
      key,
      uploadPart: async (partNumber: number, value: unknown) => {
        if (this.failPuts) throw new Error("R2 write failed.");
        find().parts.set(partNumber, await toBytes(value));
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (uploaded: Array<{ partNumber: number; etag: string }>) => {
        const upload = find();
        const chunks = uploaded.map((part) => {
          const chunk = upload.parts.get(part.partNumber);
          if (!chunk || part.etag !== `part-${part.partNumber}`) throw new Error("InvalidPart");
          return chunk;
        });
        chunks.forEach((chunk, index) => {
          const last = index === chunks.length - 1;
          if (!last && chunk.byteLength < 5 * 1024 * 1024) throw new Error("EntityTooSmall");
          if (!last && chunk.byteLength !== chunks[0].byteLength) throw new Error("Parts differ in size");
        });
        const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.uploads.delete(uploadId);
        this.objects.set(key, { body, etag: this.nextEtag(), contentType: upload.contentType, uploaded: this.clock });
        this.puts.push({ key, options: { httpMetadata: { contentType: upload.contentType } } });
        return { ...(this.objectFor(key) as object), size: body.byteLength, httpMetadata: { contentType: upload.contentType } };
      },
      abort: async () => {
        this.uploads.delete(uploadId);
        this.aborted.push(uploadId);
      },
    };
  }

  readonly aborted: string[] = [];
  get openUploads(): number {
    return this.uploads.size;
  }

  multipartUploads = 0;

  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<unknown> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = options?.range ? stored.body.slice(options.range.offset, options.range.offset + options.range.length) : stored.body;
    return {
      ...this.objectFor(key),
      json: async () =>
        JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      text: async () => new TextDecoder().decode(bytes),
      get body() {
        // `bytes` is a Uint8Array over an ArrayBufferLike, which the current
        // DOM types will not accept as a BlobPart because it could be backed
        // by a SharedArrayBuffer. It never is here.
        return new Blob([bytes as unknown as BlobPart]).stream();
      },
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string): Promise<unknown> {
    return this.objects.has(key) ? this.objectFor(key) : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDeletes) {
      throw new Error("R2 delete failed.");
    }
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.objects.delete(key);
  }

  async list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
  }): Promise<{
    objects: unknown[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }> {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;
    if (options.delimiter) {
      // R2 groups keys below the next delimiter into one prefix.
      const prefixes = new Set<string>();
      const objects: unknown[] = [];
      for (const key of [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()) {
        const at = key.indexOf(options.delimiter, prefix.length);
        if (at === -1) objects.push(this.objectFor(key));
        else prefixes.add(key.slice(0, at + options.delimiter.length));
      }
      return { objects, truncated: false, delimitedPrefixes: [...prefixes] };
    }
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;

    return {
      objects: page.map((key) => this.objectFor(key)),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
      delimitedPrefixes: [],
    };
  }

  bodyOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.body;
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    return `etag-${this.etagCounter}`;
  }

  private objectFor(key: string): {
    key: string;
    etag: string;
    size: number;
    uploaded: Date;
    httpMetadata: { contentType?: string };
  } {
    const stored = this.objects.get(key);
    if (!stored) throw new Error(`Missing fake R2 object ${key}`);
    return {
      key,
      etag: stored.etag,
      size: stored.body.byteLength,
      uploaded: new Date(stored.uploaded),
      httpMetadata: { contentType: stored.contentType },
    };
  }
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error(`Unsupported fake R2 value: ${typeof value}`);
}
