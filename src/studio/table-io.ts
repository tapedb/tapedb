/**
 * The studio's import and export of one model's rows, as CSV or JSON.
 *
 * Export writes every field: dates as ISO 8601, booleans as true/false, json
 * fields as JSON text in CSV, empty cells for null. Import reads either
 * format back (and dates as epoch milliseconds), checks every value against
 * the field's type, and plans the writes with the client's own code: a row
 * with an id is an upsert, a row without one is a create.
 */

import { plan } from "../model/plan";
import type { TxOp } from "../client/types";
import { graphFromSchemaDocument, type SchemaDocument } from "./graph";

const SYSTEM = ["createdAt", "updatedAt", "updatedSeq"];

/** Fields in export order: id, the model's fields as declared, then the system fields. */
export function exportFields(schema: SchemaDocument, model: string): string[] {
  const attributes = Object.keys(namespaceOf(schema, model).attributes).filter((name) => name !== "id" && !SYSTEM.includes(name));
  return ["id", ...attributes, ...SYSTEM];
}

function namespaceOf(schema: SchemaDocument, model: string) {
  const found = schema.namespaces.find((namespace) => namespace.apiName === model);
  if (!found) throw new Error(`There is no model "${model}".`);
  return found;
}

function typeOf(schema: SchemaDocument, model: string, field: string): string {
  if (field === "id") return "string";
  if (field === "createdAt" || field === "updatedAt") return "date";
  if (field === "updatedSeq") return "number";
  return namespaceOf(schema, model).attributes[field]?.type ?? "string";
}

/** A value as a file shows it: dates as ISO 8601. */
function fileValue(type: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (type === "date" && typeof value === "number") return new Date(value).toISOString();
  return value;
}

export function toJson(schema: SchemaDocument, model: string, rows: Array<Record<string, unknown>>): string {
  const fields = exportFields(schema, model);
  const out = rows.map((row) => {
    const shaped: Record<string, unknown> = {};
    for (const field of fields) shaped[field] = fileValue(typeOf(schema, model, field), row[field]);
    return shaped;
  });
  return JSON.stringify(out, null, 2) + "\n";
}

function csvCell(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a header row, CRLF line ends and a byte order mark, so spreadsheets read UTF-8. */
export function toCsv(schema: SchemaDocument, model: string, rows: Array<Record<string, unknown>>): string {
  const fields = exportFields(schema, model);
  const lines = [fields.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      fields
        .map((field) => {
          const type = typeOf(schema, model, field);
          const value = fileValue(type, row[field]);
          if (value === null) return "";
          if (type === "json") return csvCell(JSON.stringify(value));
          return csvCell(String(value));
        })
        .join(",")
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Parses RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, an optional byte order mark. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let at = 0;
  let line = 1;
  let started = false;
  while (at < source.length) {
    const char = source[at];
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') {
          cell += '"';
          at += 2;
          continue;
        }
        quoted = false;
        at++;
        if (at < source.length && !/[,\r\n]/.test(source[at])) {
          throw new Error(`Line ${line}: a quoted value must end at a comma or the end of the line.`);
        }
        continue;
      }
      if (char === "\n") line++;
      cell += char;
      at++;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      started = true;
      at++;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      started = true;
      at++;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
      at += char === "\r" && source[at + 1] === "\n" ? 2 : 1;
      line++;
      continue;
    }
    cell += char;
    started = true;
    at++;
  }
  if (quoted) throw new Error(`Line ${line}: a quoted value is never closed.`);
  if (started || cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
}

export interface Table {
  format: "csv" | "json";
  columns: string[];
  records: Array<Record<string, unknown>>;
}

/** A file's rows. CSV needs a header row; JSON is an array of objects. */
export function readTable(name: string, text: string): Table {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  const json = /\.json$/i.test(name) || ((trimmed.startsWith("[") || trimmed.startsWith("{")) && !/\.csv$/i.test(name));
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${name} is not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new Error(`${name} must hold an array of rows, like [{ "title": "…" }].`);
    }
    const columns: string[] = [];
    for (const record of parsed as Array<Record<string, unknown>>) {
      for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
    }
    return { format: "json", columns, records: parsed as Array<Record<string, unknown>> };
  }
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${name} is empty.`);
  const columns = rows[0].map((column) => column.trim());
  const seen = new Set<string>();
  for (const column of columns) {
    if (column === "") throw new Error(`${name}: a column in the header row has no name.`);
    if (seen.has(column)) throw new Error(`${name}: the column "${column}" appears twice.`);
    seen.add(column);
  }
  const records = rows.slice(1).map((cells, index) => {
    if (cells.length !== columns.length) {
      throw new Error(`${name}: row ${index + 1} has ${cells.length} values; the header has ${columns.length}.`);
    }
    const record: Record<string, unknown> = {};
    columns.forEach((column, i) => (record[column] = cells[i]));
    return record;
  });
  return { format: "csv", columns, records };
}

export interface ImportPlan {
  /** Rows without an id: created. */
  creates: number;
  /** Rows with an id: updated if it exists, created with it if not. */
  upserts: number;
  /** Ids the upserts name, to tell creates from updates before running. */
  ids: string[];
  /** One transaction's ops per row, in file order. */
  rows: TxOp[][];
  /** Columns that are not fields of the model, and relation values. */
  ignored: string[];
  /** System fields in the file, which the database sets itself. */
  system: string[];
  errors: Array<{ row: number; message: string }>;
}

function convert(type: string, value: unknown, csv: boolean): { value?: unknown; error?: string } {
  const shown = typeof value === "string" ? `"${value.length > 40 ? value.slice(0, 40) + "…" : value}"` : JSON.stringify(value);
  if (value === null || value === undefined || (csv && value === "")) return { value: null };
  switch (type) {
    case "string":
      if (typeof value === "string") return { value };
      return { error: `is text, not ${shown}` };
    case "number": {
      const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
      return Number.isFinite(number) ? { value: number } : { error: `is a number, not ${shown}` };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      const text = typeof value === "string" ? value.trim().toLowerCase() : value;
      if (text === "true" || text === "1" || text === "yes" || text === 1) return { value: true };
      if (text === "false" || text === "0" || text === "no" || text === 0) return { value: false };
      return { error: `is true or false, not ${shown}` };
    }
    case "date": {
      if (typeof value === "number" && Number.isFinite(value)) return { value };
      if (typeof value === "string") {
        const text = value.trim();
        const ms = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
        if (Number.isFinite(ms)) return { value: ms };
      }
      return { error: `is a date (like 2026-11-17T09:30:00Z), not ${shown}` };
    }
    case "json":
      if (!csv) return { value };
      try {
        return { value: JSON.parse(value as string) };
      } catch {
        return { error: `holds JSON, and ${shown} is not` };
      }
    default:
      return { value };
  }
}

/** Checks every row of the table against the model and plans its writes. */
export function planImport(schema: SchemaDocument, model: string, table: Table): ImportPlan {
  const graph = graphFromSchemaDocument(schema);
  const info = graph[model];
  if (!info) throw new Error(`There is no model "${model}".`);
  const attributes = namespaceOf(schema, model).attributes;
  const writable = (column: string) => column !== "id" && !SYSTEM.includes(column) && column in attributes;
  const result: ImportPlan = {
    creates: 0,
    upserts: 0,
    ids: [],
    rows: [],
    ignored: table.columns.filter((column) => column !== "id" && !SYSTEM.includes(column) && !(column in attributes)),
    system: table.columns.filter((column) => SYSTEM.includes(column)),
    errors: [],
  };
  const csv = table.format === "csv";
  const seen = new Set<string>();

  table.records.forEach((record, index) => {
    const row = index + 1;
    const fail = (message: string) => result.errors.push({ row, message });
    const data: Record<string, unknown> = {};
    const invalid = new Set<string>();
    let ok = true;
    for (const [column, raw] of Object.entries(record)) {
      if (!writable(column)) continue;
      const attribute = attributes[column];
      const converted = convert(attribute.type, raw, csv);
      if (converted.error) {
        fail(`${column} ${converted.error}.`);
        invalid.add(column);
        ok = false;
        continue;
      }
      data[column] = converted.value;
    }
    const rawId = record.id;
    const id = rawId === undefined || rawId === null || rawId === "" ? null : rawId;
    if (id !== null && typeof id !== "string") {
      fail(`id is text, not ${JSON.stringify(id)}.`);
      return;
    }
    if (id !== null && seen.has(id)) {
      fail(`id ${id} is also on an earlier row.`);
      return;
    }
    if (id !== null) seen.add(id);
    for (const [field, attribute] of Object.entries(attributes)) {
      if (!writable(field) || invalid.has(field)) continue;
      const optional = attribute.optional || (attribute.personal ? !attribute.personal.required : false);
      const hasDefault = attribute.default !== null && attribute.default !== undefined;
      if (data[field] === null && !optional) {
        // A required field left empty takes its default on a new row; otherwise it is missing.
        if (hasDefault && id === null) delete data[field];
        else {
          fail(`${field} is required.`);
          ok = false;
        }
      } else if (!(field in data) && !optional && !hasDefault && id === null) {
        fail(`${field} is required, and the file has no value for it.`);
        ok = false;
      }
    }
    if (!ok) return;
    try {
      const planned =
        id === null
          ? plan(graph, info, "create", { data })
          : plan(graph, info, "upsert", { where: { id }, create: data, update: data });
      if (planned.kind !== "write") throw new Error("not a write");
      result.rows.push(planned.ops);
      if (id === null) result.creates++;
      else {
        result.upserts++;
        result.ids.push(id);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  });
  return result;
}
