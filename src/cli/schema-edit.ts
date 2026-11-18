/**
 * Edits `tapedb.schema.ts` as text, for the studio's structure editor.
 *
 * The schema is code the user owns: comments, formatting, access rules and
 * helpers stay exactly as written. Only the entries an edit names are touched,
 * found by scanning the `schema({ ... })` call with a small tokenizer that
 * knows strings, template literals and comments. Anything it cannot read is
 * reported, never guessed at; the result is always loaded and validated by
 * the caller before it is written.
 */

export type ScalarType = "string" | "number" | "boolean" | "date" | "json";

/** A field the studio can write and read back. Anything else is shown as code. */
export type FieldSpec =
  | {
      type: ScalarType;
      optional?: boolean;
      default?: string | number | boolean;
      index?: boolean;
      unique?: boolean;
    }
  | {
      type: "enum";
      values: string[];
      optional?: boolean;
      default?: string;
      index?: boolean;
      unique?: boolean;
    }
  | { type: "belongsTo"; target: string; optional?: boolean; onDelete?: "setNull" | "cascade" | "restrict" }
  | { type: "hasMany"; target: string };

export type SchemaEdit =
  | { kind: "addModel"; model: string; fields: Array<{ name: string; spec: FieldSpec }> }
  | { kind: "deleteModel"; model: string }
  | { kind: "renameModel"; from: string; to: string }
  | { kind: "addField"; model: string; field: string; spec: FieldSpec }
  | { kind: "changeField"; model: string; field: string; spec: FieldSpec }
  | { kind: "deleteField"; model: string; field: string }
  | { kind: "renameField"; model: string; from: string; to: string };

export class SchemaEditError extends Error {}

interface Entry {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  /** After the trailing comma, if any. */
  end: number;
}

interface ObjectLiteral {
  open: number;
  close: number;
  entries: Entry[];
}

export interface ParsedModel {
  name: string;
  entry: Entry;
  fields: ObjectLiteral;
}

export interface ParsedSchema {
  models: ParsedModel[];
  modelsObject: ObjectLiteral;
  options: ObjectLiteral | null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

// ---- Scanning ----------------------------------------------------------------

/** Index just past a string, template literal or comment starting at `i`, or `i`. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const end = src.indexOf("\n", i);
    return end === -1 ? src.length : end;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    if (end === -1) throw new SchemaEditError("Unclosed comment in the schema file.");
    return end + 2;
  }
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === c) return j + 1;
      else if (src[j] === "\n") break;
    }
    throw new SchemaEditError("Unclosed string in the schema file.");
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "`") return j + 1;
      else if (src[j] === "$" && src[j + 1] === "{") j = matching(src, j + 1);
    }
    throw new SchemaEditError("Unclosed template literal in the schema file.");
  }
  return i;
}

/** Index of the bracket that closes the one at `open`. */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[src[open]]];
  for (let i = open + 1; i < src.length; i++) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const c = src[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) throw new SchemaEditError("Unbalanced brackets in the schema file.");
      if (stack.length === 0) return i;
    }
  }
  throw new SchemaEditError("Unbalanced brackets in the schema file.");
}

/** Next index at or after `i` that is not whitespace or a comment. */
function skipTrivia(src: string, i: number): number {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    const skipped = skipLiteral(src, i);
    if (skipped !== i && src[i] === "/") { i = skipped; continue; }
    break;
  }
  return i;
}

/** The entries of the object literal whose `{` is at `open`. */
function parseObject(src: string, open: number): ObjectLiteral {
  if (src[open] !== "{") throw new SchemaEditError("Expected an object literal.");
  const close = matching(src, open);
  const entries: Entry[] = [];
  let i = skipTrivia(src, open + 1);
  while (i < close) {
    if (src.startsWith("...", i)) throw new SchemaEditError("The schema spreads another object into its models; edit it in code.");
    let key: string;
    const keyStart = i;
    if (src[i] === '"' || src[i] === "'") {
      const end = skipLiteral(src, i);
      key = src.slice(i + 1, end - 1);
      i = end;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, close));
      if (!match) throw new SchemaEditError("The schema has an entry the studio cannot read; edit it in code.");
      key = match[0];
      i += key.length;
    }
    const keyEnd = i;
    i = skipTrivia(src, i);
    if (src[i] !== ":") throw new SchemaEditError(`"${key}" is not written as \`${key}: ...\`; edit it in code.`);
    const valueStart = skipTrivia(src, i + 1);
    let j = valueStart;
    while (j < close && src[j] !== ",") {
      const skipped = skipLiteral(src, j);
      if (skipped !== j) { j = skipped; continue; }
      if (src[j] === "(" || src[j] === "[" || src[j] === "{") { j = matching(src, j) + 1; continue; }
      j++;
    }
    let valueEnd = j;
    while (valueEnd > valueStart && /\s/.test(src[valueEnd - 1])) valueEnd--;
    const end = src[j] === "," ? j + 1 : j;
    entries.push({ key, keyStart, keyEnd, valueStart, valueEnd, end });
    i = skipTrivia(src, end);
  }
  return { open, close, entries };
}

/** Finds `schema({ ... }, { ... }?)` and the `model({ ... })` inside each entry. */
export function parseSchemaSource(src: string): ParsedSchema {
  let call = -1;
  for (let i = 0; i < src.length; i++) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (src.startsWith("schema", i) && !/[A-Za-z0-9_$.]/.test(src[i - 1] ?? "")) {
      const paren = skipTrivia(src, i + "schema".length);
      if (src[paren] === "(") { call = paren; break; }
    }
  }
  if (call === -1) throw new SchemaEditError("No schema({ ... }) call found in the schema file.");
  const modelsOpen = skipTrivia(src, call + 1);
  if (src[modelsOpen] !== "{") throw new SchemaEditError("schema() is not called with an object of models; edit it in code.");
  const modelsObject = parseObject(src, modelsOpen);
  let options: ObjectLiteral | null = null;
  const after = skipTrivia(src, modelsObject.close + 1);
  if (src[after] === ",") {
    const next = skipTrivia(src, after + 1);
    if (src[next] === "{") options = parseObject(src, next);
  }
  const models = modelsObject.entries.map((entry) => {
    const value = src.slice(entry.valueStart, entry.valueEnd);
    const match = /^model\s*\(/.exec(value);
    if (!match) throw new SchemaEditError(`Model "${entry.key}" is not written as model({ ... }); edit it in code.`);
    const open = skipTrivia(src, entry.valueStart + match[0].length);
    if (src[open] !== "{") throw new SchemaEditError(`Model "${entry.key}" is not written as model({ ... }); edit it in code.`);
    return { name: entry.key, entry, fields: parseObject(src, open) };
  });
  return { models, modelsObject, options };
}

// ---- Access rules as code -----------------------------------------------------

export interface AccessSource {
  /** Per model, each action's rule as written: `filter(({ auth }) => ...)`. */
  models: Record<string, Record<string, string>>;
  /** The `files` option's rules as written. */
  files: Record<string, string>;
}

function entriesAsCode(src: string, object: ObjectLiteral): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of object.entries) out[entry.key] = src.slice(entry.valueStart, entry.valueEnd);
  return out;
}

/** The access rules as written in the schema file, for the studio to show next to what they decide. */
export function accessSource(src: string): AccessSource {
  const parsed = parseSchemaSource(src);
  const models: AccessSource["models"] = {};
  for (const model of parsed.models) {
    // model({ ... }) then a chain: .access({ ... }), and whatever else follows.
    let i = skipTrivia(src, model.fields.close + 1);
    if (src[i] !== ")") continue;
    i = skipTrivia(src, i + 1);
    while (i < model.entry.valueEnd && src[i] === ".") {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(skipTrivia(src, i + 1)))?.[0];
      if (!name) break;
      const paren = skipTrivia(src, skipTrivia(src, i + 1) + name.length);
      if (src[paren] !== "(") break;
      const argument = skipTrivia(src, paren + 1);
      if (name === "access" && src[argument] === "{") {
        try {
          models[model.name] = entriesAsCode(src, parseObject(src, argument));
        } catch {
          // Written in a way this reader does not follow: the studio shows the rule's effect only.
        }
      }
      i = skipTrivia(src, matching(src, paren) + 1);
    }
  }
  let files: Record<string, string> = {};
  const option = parsed.options?.entries.find((entry) => entry.key === "files");
  if (option && src[option.valueStart] === "{") {
    try {
      files = entriesAsCode(src, parseObject(src, option.valueStart));
    } catch {
      files = {};
    }
  }
  return { models, files };
}

// ---- Fields as code --------------------------------------------------------------

function literal(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** The builder expression for a field. */
export function renderField(spec: FieldSpec): string {
  if (spec.type === "belongsTo") {
    const options = spec.onDelete && spec.onDelete !== "setNull" ? `, { onDelete: "${spec.onDelete}" }` : "";
    return `t.belongsTo(${JSON.stringify(spec.target)}${options})${spec.optional ? ".optional()" : ""}`;
  }
  if (spec.type === "hasMany") return `t.hasMany(${JSON.stringify(spec.target)})`;
  if (spec.type === "enum") {
    let code = `t.enum([${spec.values.map((value) => JSON.stringify(value)).join(", ")}])`;
    if (spec.optional) code += ".optional()";
    if (spec.default !== undefined) code += `.default(${JSON.stringify(spec.default)})`;
    if (spec.unique) code += ".unique()";
    else if (spec.index) code += ".index()";
    return code;
  }
  let code = `t.${spec.type}()`;
  if (spec.optional) code += ".optional()";
  if (spec.default !== undefined) code += `.default(${literal(spec.default)})`;
  if (spec.unique) code += ".unique()";
  else if (spec.index) code += ".index()";
  return code;
}

/** Reads a builder expression the studio wrote (or one written the same way), else null. */
export function readField(code: string): FieldSpec | null {
  const text = code.replace(/\s+/g, "");
  let m = /^t\.belongsTo\(("[A-Za-z][A-Za-z0-9]*"|'[A-Za-z][A-Za-z0-9]*')(?:,\{onDelete:["'](setNull|cascade|restrict)["']\})?\)(\.optional\(\))?$/.exec(text);
  if (m) return { type: "belongsTo", target: m[1].slice(1, -1), ...(m[3] ? { optional: true } : {}), ...(m[2] && m[2] !== "setNull" ? { onDelete: m[2] as "cascade" | "restrict" } : {}) };
  m = /^t\.hasMany\(("[A-Za-z][A-Za-z0-9]*"|'[A-Za-z][A-Za-z0-9]*')\)$/.exec(text);
  if (m) return { type: "hasMany", target: m[1].slice(1, -1) };
  m = /^t\.enum\(\[((?:"(?:[^"\\]|\\.)*")(?:,"(?:[^"\\]|\\.)*")*)\]\)((?:\.(?:optional|index|unique)\(\)|\.default\("(?:[^"\\]|\\.)*"\))*)$/.exec(text);
  if (m) {
    const values = (m[1].match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((quoted) => JSON.parse(quoted) as string);
    const spec: Extract<FieldSpec, { type: "enum" }> = { type: "enum", values };
    for (const part of m[2].match(/\.[a-z]+\([^)]*\)/g) ?? []) {
      if (part === ".optional()") spec.optional = true;
      else if (part === ".index()") spec.index = true;
      else if (part === ".unique()") spec.unique = true;
      else spec.default = JSON.parse(part.slice(".default(".length, -1)) as string;
    }
    return spec;
  }
  m = /^t\.(string|number|boolean|date|json)\(\)((?:\.(?:optional|index|unique)\(\)|\.default\((?:-?\d+(?:\.\d+)?|true|false|"(?:[^"\\]|\\.)*")\))*)$/.exec(text);
  if (!m) return null;
  const spec: Extract<FieldSpec, { type: ScalarType }> = { type: m[1] as ScalarType };
  for (const part of m[2].match(/\.[a-z]+\([^)]*\)/g) ?? []) {
    if (part === ".optional()") spec.optional = true;
    else if (part === ".index()") spec.index = true;
    else if (part === ".unique()") spec.unique = true;
    else spec.default = JSON.parse(part.slice(".default(".length, -1));
  }
  // Read from the original text, so spacing inside a string default survives.
  if (typeof spec.default === "string") {
    const original = /\.default\(\s*("(?:[^"\\]|\\.)*")\s*\)/.exec(code);
    if (original) spec.default = JSON.parse(original[1]);
  }
  return spec;
}

/** The fields a relation expression points at a model with. */
function targetOf(code: string): string | null {
  const m = /^\s*t\s*\.\s*(?:belongsTo|hasMany|hasOne)\s*\(\s*(["'])([A-Za-z][A-Za-z0-9]*)\1/.exec(code);
  return m ? m[2] : null;
}

// ---- Text edits ----------------------------------------------------------------

interface Change { start: number; end: number; text: string }

function applyChanges(src: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new SchemaEditError("Overlapping edits.");
  }
  let out = src;
  for (const change of sorted) out = out.slice(0, change.start) + change.text + out.slice(change.end);
  return out;
}

/** Removes an entry: its own lines when it has them, else just the entry. */
function removal(src: string, entry: Entry): Change {
  const lineStart = src.lastIndexOf("\n", entry.keyStart - 1) + 1;
  const ownLine = /^[ \t]*$/.test(src.slice(lineStart, entry.keyStart));
  let end = entry.end;
  while (end < src.length && (src[end] === " " || src[end] === "\t")) end++;
  if (ownLine && (src[end] === "\n" || src.startsWith("\r\n", end))) {
    end += src[end] === "\r" ? 2 : 1;
    // Between blank lines, take one of them too, so no double gap is left.
    const blankBefore = /\n[ \t]*\r?\n$/.test(src.slice(0, lineStart));
    const blankAfter = /^[ \t]*\r?\n/.exec(src.slice(end));
    if (blankBefore && blankAfter) end += blankAfter[0].length;
    return { start: lineStart, end, text: "" };
  }
  return { start: entry.keyStart, end, text: "" };
}

/** Adds an entry after the last one, in its indentation. */
function insertion(src: string, object: ObjectLiteral, text: string): Change[] {
  const last = object.entries.at(-1);
  if (!last) {
    const lineStart = src.lastIndexOf("\n", object.open) + 1;
    const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
    return [{ start: object.open + 1, end: object.close, text: `\n${indent}  ${text},\n${indent}` }];
  }
  const lineStart = src.lastIndexOf("\n", last.keyStart - 1) + 1;
  const prefix = src.slice(lineStart, last.keyStart);
  const comma = src[last.end - 1] === ",";
  if (/^[ \t]*$/.test(prefix)) {
    // One entry per line: a new line in the same indentation, after the comma.
    return comma
      ? [{ start: last.end, end: last.end, text: `\n${prefix}${text},` }]
      : [{ start: last.valueEnd, end: last.valueEnd, text: `,\n${prefix}${text},` }];
  }
  // Inline: keep it inline, in the same comma style.
  return comma
    ? [{ start: last.end, end: last.end, text: ` ${text},` }]
    : [{ start: last.valueEnd, end: last.valueEnd, text: `, ${text}` }];
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function requireName(name: string, what: string): void {
  if (!NAME.test(name)) throw new SchemaEditError(`A ${what} name starts with a letter and has only letters and digits.`);
}

function findModel(parsed: ParsedSchema, name: string): ParsedModel {
  const model = parsed.models.find((m) => m.name === name);
  if (!model) throw new SchemaEditError(`There is no model "${name}" in the schema file.`);
  return model;
}

function findField(model: ParsedModel, name: string): Entry {
  const field = model.fields.entries.find((e) => e.key === name);
  if (!field) throw new SchemaEditError(`Model "${model.name}" has no field "${name}".`);
  return field;
}

/** Entries of the options object (rules, files...) keyed by a model name. */
function optionEntriesFor(src: string, parsed: ParsedSchema, model: string): Entry[] {
  if (!parsed.options) return [];
  const found: Entry[] = [];
  for (const section of parsed.options.entries) {
    const open = skipTrivia(src, section.valueStart);
    if (src[open] !== "{" || open >= section.valueEnd) continue;
    for (const entry of parseObject(src, open).entries) if (entry.key === model) found.push(entry);
  }
  return found;
}

export interface EditResult {
  source: string;
  /** For the migration: "old=new" or "model.old=new", by stored attribute name. */
  renames: string[];
  /** A name for the migration file. */
  name: string;
}

/** Applies one edit to the schema source. Throws SchemaEditError for what it cannot do. */
export function editSchemaSource(src: string, edit: SchemaEdit): EditResult {
  const parsed = parseSchemaSource(src);
  const changes: Change[] = [];
  const renames: string[] = [];
  let name: string;

  switch (edit.kind) {
    case "addModel": {
      requireName(edit.model, "model");
      if (parsed.models.some((m) => m.name === edit.model)) throw new SchemaEditError(`A model "${edit.model}" exists already.`);
      const fields = edit.fields.map((f) => { requireName(f.name, "field"); return `${key(f.name)}: ${renderField(f.spec)}`; });
      const last = parsed.models.at(-1);
      let indent = "  ";
      if (last) {
        const lineStart = src.lastIndexOf("\n", last.entry.keyStart - 1) + 1;
        indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
      }
      const body = fields.length === 0 ? "model({})" : `model({\n${fields.map((f) => `${indent}  ${f},`).join("\n")}\n${indent}})`;
      changes.push(...insertion(src, parsed.modelsObject, `${key(edit.model)}: ${body}`));
      name = `add_${edit.model}`;
      break;
    }
    case "deleteModel": {
      const model = findModel(parsed, edit.model);
      changes.push(removal(src, model.entry));
      // Relations elsewhere that point at it go with it, or the schema would not load.
      for (const other of parsed.models) {
        if (other === model) continue;
        for (const field of other.fields.entries) {
          if (targetOf(src.slice(field.valueStart, field.valueEnd)) === edit.model) changes.push(removal(src, field));
        }
      }
      for (const entry of optionEntriesFor(src, parsed, edit.model)) changes.push(removal(src, entry));
      name = `drop_${edit.model}`;
      break;
    }
    case "renameModel": {
      requireName(edit.to, "model");
      const model = findModel(parsed, edit.from);
      if (parsed.models.some((m) => m.name === edit.to)) throw new SchemaEditError(`A model "${edit.to}" exists already.`);
      changes.push({ start: model.entry.keyStart, end: model.entry.keyEnd, text: key(edit.to) });
      for (const other of parsed.models) {
        for (const field of other.fields.entries) {
          const code = src.slice(field.valueStart, field.valueEnd);
          if (targetOf(code) !== edit.from) continue;
          const m = /(["'])([A-Za-z][A-Za-z0-9]*)\1/.exec(code)!;
          const at = field.valueStart + m.index + 1;
          changes.push({ start: at, end: at + edit.from.length, text: edit.to });
        }
      }
      for (const entry of optionEntriesFor(src, parsed, edit.from)) changes.push({ start: entry.keyStart, end: entry.keyEnd, text: key(edit.to) });
      renames.push(`${edit.from}=${edit.to}`);
      name = `rename_${edit.from}_to_${edit.to}`;
      break;
    }
    case "addField": {
      requireName(edit.field, "field");
      const model = findModel(parsed, edit.model);
      if (model.fields.entries.some((e) => e.key === edit.field)) throw new SchemaEditError(`Model "${edit.model}" has a field "${edit.field}" already.`);
      changes.push(...insertion(src, model.fields, `${key(edit.field)}: ${renderField(edit.spec)}`));
      name = `add_${edit.model}_${edit.field}`;
      break;
    }
    case "changeField": {
      const model = findModel(parsed, edit.model);
      const field = findField(model, edit.field);
      changes.push({ start: field.valueStart, end: field.valueEnd, text: renderField(edit.spec) });
      name = `change_${edit.model}_${edit.field}`;
      break;
    }
    case "deleteField": {
      const model = findModel(parsed, edit.model);
      changes.push(removal(src, findField(model, edit.field)));
      name = `drop_${edit.model}_${edit.field}`;
      break;
    }
    case "renameField": {
      requireName(edit.to, "field");
      const model = findModel(parsed, edit.model);
      const field = findField(model, edit.from);
      if (model.fields.entries.some((e) => e.key === edit.to)) throw new SchemaEditError(`Model "${edit.model}" has a field "${edit.to}" already.`);
      changes.push({ start: field.keyStart, end: field.keyEnd, text: key(edit.to) });
      const spec = readField(src.slice(field.valueStart, field.valueEnd));
      if (spec?.type === "hasMany") {
        // Stores nothing: nothing to migrate.
      } else if (spec?.type === "belongsTo" || /^\s*t\s*\.\s*belongsTo\b/.test(src.slice(field.valueStart, field.valueEnd))) {
        renames.push(`${edit.model}.${edit.from}Id=${edit.to}Id`);
      } else {
        renames.push(`${edit.model}.${edit.from}=${edit.to}`);
      }
      name = `rename_${edit.model}_${edit.from}_to_${edit.to}`;
      break;
    }
  }
  return { source: applyChanges(src, changes), renames, name };
}

// ---- Line diff, for the preview ---------------------------------------------------

export interface DiffLine { kind: " " | "-" | "+"; text: string; old?: number; new?: number }

/** A line diff with `context` unchanged lines around each change; "…" lines mark gaps. */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const all: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { all.push({ kind: " ", text: a[i], old: i + 1, new: j + 1 }); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { all.push({ kind: "+", text: b[j], new: j + 1 }); j++; }
    else { all.push({ kind: "-", text: a[i], old: i + 1 }); i++; }
  }
  const keep = all.map(() => false);
  all.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let gap = false;
  all.forEach((line, index) => {
    if (keep[index]) { out.push(line); gap = false; }
    else if (!gap) { out.push({ kind: " ", text: "…" }); gap = true; }
  });
  return out;
}
