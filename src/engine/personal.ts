import { changesAfter, evolveTable, evolveColumn } from "./schema-evolution";
import type { Env } from "../types";
import { NAMESPACES, toSnakeCase, type NamespaceDefinition } from "./registry";
import type { SqlExecutor, SqlRow, SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";

const PREFIX = "tapedb:personal:v1:";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytes = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;
function b64(value: ArrayBuffer | Uint8Array): string {
  const data = new Uint8Array(value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value);
  let text = ""; for (let at = 0; at < data.length; at += 32768) text += String.fromCharCode(...data.subarray(at, at + 32768));
  return btoa(text);
}
function unb64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
interface Envelope { s: string; k: string; n: string; c: string; erased?: boolean; t: string; f: string; v: string | null }
interface WrappedKey { id: string; n: string; c: string }
interface Key { id: string; key: CryptoKey }
export function hasPersonalFields(): boolean { return Object.values(NAMESPACES).some(model => Object.values(model.attributes).some(field => field.personal)); }
export const personalKeyPrefix = (workspace: string) => `keys/${workspace}/`;
export class PersonalPending extends Error {
  constructor(readonly tasks: Array<() => Promise<void>>) { super("Personal values need cryptographic preparation."); }
}
function envelope(value: SqlValue): { token: string; value: Envelope } | null {
  if (typeof value !== "string") return null;
  let text = value;
  if (text.startsWith('"')) { try { text = JSON.parse(text); } catch { return null; } }
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  const parsed = JSON.parse(text.slice(PREFIX.length)) as Envelope;
  if (typeof parsed.s !== "string" || typeof parsed.k !== "string" || typeof parsed.n !== "string" || typeof parsed.c !== "string") throw new Error("Invalid personal ciphertext.");
  return { token: text, value: parsed };
}

export function isPersonalCiphertext(value: SqlValue): boolean { return envelope(value) !== null; }

/** Plaintext kept across reads, in UTF-16 units; the oldest goes first. */
export const PLAINTEXT_CACHE_UNITS = 8 * 1024 * 1024;

function units(key: string, value: SqlValue): number {
  return key.length + (typeof value === "string" ? value.length : JSON.stringify(value ?? null).length);
}

/** Per-room keys and plaintext live only in memory. R2 stores wrapped keys. */
export class PersonalRuntime {
  private readonly keys = new Map<string, Key | null>();
  /** Bounded, least recently used first; a Durable Object has 128 MB. */
  private readonly clear = new Map<string, SqlValue>();
  private clearUnits = 0;
  /** What each read in progress has decrypted, kept until it finishes. */
  private readonly reading = new Set<Map<string, SqlValue>>();
  private readonly erasing = new Set<string>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private epoch = 0;
  private readonly kek: Promise<CryptoKey>;
  private readonly naming: Promise<CryptoKey>;
  constructor(private readonly env: Env, readonly workspace: string) {
    if (!env.TAPEDB_KEY_SECRET || env.TAPEDB_KEY_SECRET.length < 32) throw new Error("Personal fields require TAPEDB_KEY_SECRET with at least 32 characters.");
    this.kek = crypto.subtle.digest("SHA-256", encoder.encode(`tapedb-wrap:${env.TAPEDB_KEY_SECRET}`)).then(raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    this.naming = crypto.subtle.importKey("raw", encoder.encode(env.TAPEDB_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  async subjectHash(subject: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await this.naming, encoder.encode(`${this.workspace}:${subject}`))), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  private aad(hash: string, keyId: string, model: string, id: string, field: string): Uint8Array {
    return encoder.encode(JSON.stringify([this.workspace, hash, keyId, model, id, field]));
  }
  private async load(hash: string, create: boolean): Promise<Key | null> {
    if (this.erasing.has(hash)) throw new TxError("storage_error", "This subject is being erased; retry shortly.");
    const known = this.keys.get(hash);
    if (known || known === null && !create) return known;
    const path = personalKeyPrefix(this.workspace) + hash;
    let object = await this.env.DATA.get(path);
    if (!object && create) {
      const raw = crypto.getRandomValues(new Uint8Array(32)), id = crypto.randomUUID(), iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: bytes(this.aad(hash, id, "key", "", "")) }, await this.kek, bytes(raw));
      await this.env.DATA.put(path, JSON.stringify({ id, n: b64(iv), c: b64(ciphertext) } satisfies WrappedKey), { onlyIf: { etagDoesNotMatch: "*" } });
      object = await this.env.DATA.get(path);
    }
    if (!object) { this.keys.set(hash, null); return null; }
    const wrapped = await object.json<WrappedKey>();
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(unb64(wrapped.n)), additionalData: bytes(this.aad(hash, wrapped.id, "key", "", "")) }, await this.kek, bytes(unb64(wrapped.c)));
    const key = { id: wrapped.id, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
    this.keys.set(hash, key); return key;
  }
  private async track<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    if (this.erasing.has(hash)) throw new TxError("storage_error", "This subject is being erased; retry shortly.");
    const tasks = this.pending.get(hash) ?? new Set<Promise<unknown>>(); this.pending.set(hash, tasks);
    const task = operation(); tasks.add(task);
    try { return await task; } finally { tasks.delete(task); if (!tasks.size) this.pending.delete(hash); }
  }
  async seal(model: NamespaceDefinition, id: string, field: string, value: SqlValue, subject: string, version: string | null = null): Promise<SqlValue> {
    if (value === null) return null;
    const hash = await this.subjectHash(subject);
    return this.track(hash, async () => {
      const key = (await this.load(hash, true))!;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: bytes(this.aad(hash, key.id, model.table, id, field)) }, key.key, encoder.encode(JSON.stringify(value)));
      const token = PREFIX + JSON.stringify({ s: hash, k: key.id, n: b64(iv), c: b64(cipher), t: model.table, f: field, v: version } satisfies Envelope);
      // Cache the stored form, not an API projection.
      this.remember(`${model.table}:${id}:${field}:${token}`, value);
      return model.attributes[field].type === "json" ? JSON.stringify(token) : token;
    });
  }
  private remember(cache: string, value: SqlValue): void {
    for (const pinned of this.reading) pinned.set(cache, value);
    const prior = this.clear.get(cache);
    if (this.clear.has(cache)) {
      this.clearUnits -= units(cache, prior!);
      this.clear.delete(cache);
    }
    this.clear.set(cache, value);
    this.clearUnits += units(cache, value);
    for (const [key, old] of this.clear) {
      if (this.clearUnits <= PLAINTEXT_CACHE_UNITS) break;
      this.clear.delete(key);
      this.clearUnits -= units(key, old);
    }
  }
  private recall(cache: string): { value: SqlValue } | undefined {
    for (const pinned of this.reading) if (pinned.has(cache)) return { value: pinned.get(cache)! };
    if (!this.clear.has(cache)) return undefined;
    const value = this.clear.get(cache)!;
    this.clear.delete(cache);
    this.clear.set(cache, value);
    return { value };
  }
  /** Entries and size of the plaintext cache, for tests. */
  cacheSize(): { entries: number; units: number } {
    return { entries: this.clear.size, units: this.clearUnits };
  }
  private async open(model: NamespaceDefinition, id: string, field: string, item: { token: string; value: Envelope }): Promise<void> {
    const { value, token } = item;
    const version = this.epoch;
    const changes = changesAfter(value.v);
    if (evolveTable(value.t, changes) !== model.table || evolveColumn(value.t, toSnakeCase(value.f), changes) !== toSnakeCase(field))
      throw new Error("Personal ciphertext belongs to a different field.");
    await this.track(value.s, async () => {
      const key = value.erased ? null : await this.load(value.s, false);
      let plain: SqlValue = null;
      if (key?.id === value.k) {
        const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(unb64(value.n)), additionalData: bytes(this.aad(value.s, key.id, value.t, id, value.f)) }, key.key, bytes(unb64(value.c)));
        plain = JSON.parse(decoder.decode(raw)) as SqlValue;
      }
      if (version === this.epoch) this.remember(`${model.table}:${id}:${field}:${token}`, plain);
    });
  }
  decodeRows(namespace: string, rows: SqlRow[]): SqlRow[] {
    const model = NAMESPACES[namespace]; if (!model) return rows;
    const pending: Array<() => Promise<void>> = [];
    const output = rows.map(row => {
      const copy = { ...row }; const erased: string[] = [];
      for (const [field, definition] of Object.entries(model.attributes)) {
        const column = toSnakeCase(field); if (!definition.personal || !(column in copy)) continue;
        const item = envelope(copy[column]); if (!item) continue;
        const cache = `${model.table}:${String(row.id)}:${field}:${item.token}`;
        const known = this.recall(cache);
        if (!known) { pending.push(() => this.open(model, String(row.id), field, item)); continue; }
        copy[column] = known.value;
        if (copy[column] === null) erased.push(field);
      }
      if (erased.length) copy.__tapedb_erased = JSON.stringify(erased);
      return copy;
    });
    if (pending.length) throw new PersonalPending(pending);
    return output;
  }
  async read<T>(fn: () => T): Promise<T> {
    // Values this read decrypts stay available to it however small the
    // shared cache is, so a read larger than the cache still finishes.
    const pinned = new Map<string, SqlValue>();
    this.reading.add(pinned);
    try {
      for (;;) {
        try { return fn(); }
        catch (error) {
          if (!(error instanceof PersonalPending)) throw error;
          // Bounded concurrent key reads and Web Crypto work.
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(8, error.tasks.length) }, async () => { while (next < error.tasks.length) await error.tasks[next++](); }));
        }
      }
    } finally {
      this.reading.delete(pinned);
    }
  }
  sql(base: SqlExecutor): SqlExecutor { return { ...base, decodeRows: (namespace, rows) => this.decodeRows(namespace, rows) }; }
  async prepare(sql: SqlExecutor, model: NamespaceDefinition, id: string, values: Record<string, SqlValue>, inserting: boolean, erased: readonly string[] = []): Promise<Record<string, SqlValue>> {
    if (!Object.values(model.attributes).some(field => field.personal)) return values;
    const stored = sql.one<SqlRow>(`SELECT * FROM "${model.table}" WHERE id = ?`, id);
    const old = stored ? await this.read(() => this.decodeRows(model.apiName, [stored])[0]) : undefined;
    const result = { ...values };
    for (const [field, definition] of Object.entries(model.attributes)) {
      const personal = definition.personal; if (!personal) continue;
      const column = toSnakeCase(field);
      if (erased.includes(field)) {
        if (values[column] !== null) throw new TxError("invalid_op", "An erased field must be null.");
        const subject = personal.subject === "self" ? id : values[toSnakeCase(personal.subject)];
        const token = PREFIX + JSON.stringify({ s: await this.subjectHash(String(subject)), k: crypto.randomUUID(), n: "", c: "", erased: true, t: model.table, f: field, v: null } satisfies Envelope);
        result[column] = definition.type === "json" ? JSON.stringify(token) : token;
        continue;
      }
      if (personal.required && column in values && values[column] === null) throw new TxError("invalid_op", `Personal field ${field} is required.`);
      if (inserting && !(column in result)) {
        if (personal.defaultValue !== undefined) result[column] = personal.defaultValue;
        else if (personal.required) throw new TxError("invalid_op", `Personal field ${field} is required.`);
      }
      const subjectColumn = personal.subject === "self" ? "id" : toSnakeCase(personal.subject);
      const subject = personal.subject === "self" ? id : (subjectColumn in values ? values[subjectColumn] : stored?.[subjectColumn]);
      const subjectChanged = stored && subjectColumn in values && values[subjectColumn] !== stored[subjectColumn];
      if (!(column in result) && subjectChanged) {
        if (old?.[column] === null && stored && envelope(stored[column])) {
          result[column] = stored[column];
          continue; // Preserve the erased marker; no key can recover this value.
        }
        result[column] = old?.[column] ?? null;
      }
      if (!(column in result)) continue;
      if (result[column] !== null && typeof subject !== "string") throw new TxError("invalid_op", `Personal field ${field} needs a string subject.`);
      result[column] = await this.seal(model, id, field, result[column], String(subject), sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`)?.value ?? null);
    }
    return result;
  }
  async erase(subject: string): Promise<void> {
    const hash = await this.subjectHash(subject);
    this.erasing.add(hash); this.epoch++;
    try {
      await Promise.allSettled([...(this.pending.get(hash) ?? [])]);
      await this.env.DATA.delete(personalKeyPrefix(this.workspace) + hash);
      this.keys.delete(hash); this.clearPlaintext(); this.epoch++;
    } finally { this.erasing.delete(hash); }
  }
  clearPlaintext(): void {
    this.clear.clear();
    this.clearUnits = 0;
    for (const pinned of this.reading) pinned.clear();
  }
  /**
   * The receipt hash of a transaction that may carry personal values: an
   * HMAC under the key secret, so the hash kept in receipts and log lines
   * cannot be brute-forced back to a short value (a phone number, a date).
   */
  async receiptHash(rawOps: unknown): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", await this.naming, encoder.encode(`receipt:${JSON.stringify(rawOps)}`));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}
