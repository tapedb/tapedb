/**
 * Adds an extension to the project's code, as text: the schema's
 * `schema(models, { extensions: [...] })` and the Worker's
 * `defineTapeDB({ extensions: [...] })`, with the imports they need.
 *
 * The files are the user's code, so the edit is the smallest one that works:
 * one entry in an `extensions` array (created if absent) and the missing
 * import lines, and nothing else moves. Code it cannot read with certainty
 * (the options built elsewhere, `extensions` not written as an array) is
 * reported with SchemaEditError and left alone.
 */
import { matching, SchemaEditError, skipLiteral, skipTrivia } from "./schema-edit";

interface Item {
  start: number;
  /** Just past the value, before any trailing whitespace. */
  end: number;
  /** null for a spread or anything that is not `key: value` or a shorthand. */
  key: string | null;
  valueStart: number;
  /** The index of the comma after it, or -1. */
  comma: number;
}

/** The top-level items of the object or array literal whose bracket is at `open`. */
function items(src: string, open: number): { close: number; items: Item[] } {
  const close = matching(src, open);
  const out: Item[] = [];
  let i = skipTrivia(src, open + 1);
  while (i < close) {
    const start = i;
    let j = i;
    while (j < close && src[j] !== ",") {
      const skipped = skipLiteral(src, j);
      if (skipped !== j) { j = skipped; continue; }
      if (src[j] === "(" || src[j] === "[" || src[j] === "{") { j = matching(src, j) + 1; continue; }
      j++;
    }
    let end = j;
    while (end > start && /\s/.test(src[end - 1]!)) end--;
    const text = src.slice(start, end);
    const named = /^([A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*(:)?/.exec(text);
    let key: string | null = null;
    let valueStart = start;
    if (named && named[2]) {
      key = named[1]!.replace(/^["']|["']$/g, "");
      valueStart = skipTrivia(src, start + named[0].length);
    } else if (named && named[0].length === text.length) {
      key = named[1]!; // shorthand
    }
    out.push({ start, end, key, valueStart, comma: src[j] === "," ? j : -1 });
    i = skipTrivia(src, src[j] === "," ? j + 1 : j);
  }
  return { close, items: out };
}

/** The `(` of the first call to `name` in code (not in a string or comment, not a property). */
function findCall(src: string, name: string): number {
  for (let i = 0; i < src.length; i++) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (src.startsWith(name, i) && !/[\w$.]/.test(src[i - 1] ?? "") && !/[\w$]/.test(src[i + name.length] ?? "")) {
      const paren = skipTrivia(src, i + name.length);
      if (src[paren] === "(") return paren;
    }
  }
  return -1;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** Inserts `text` as the last item of the literal at `open`, matching its layout. */
function append(src: string, open: number, text: string): string {
  const { close, items: list } = items(src, open);
  const last = list[list.length - 1];
  if (!last) {
    const pad = src[open] === "{" ? " " : "";
    return src.slice(0, open + 1) + pad + text + pad + src.slice(close);
  }
  const multiline = src.slice(open, close).includes("\n");
  if (multiline) {
    const lineStart = src.lastIndexOf("\n", last.start) + 1;
    const indent = /^\s*/.exec(src.slice(lineStart, last.start))![0];
    const after = last.comma === -1 ? last.end : last.comma + 1;
    return src.slice(0, last.end) + "," + src.slice(last.end, after).replace(/^,/, "") + `\n${indent}${text},` + src.slice(after);
  }
  const after = last.comma === -1 ? last.end : last.comma + 1;
  return src.slice(0, last.end) + ", " + text + src.slice(after);
}

/** `extensions: [..., expression]` in the object literal at `open`; null when it is already there. */
function addToExtensions(src: string, open: number, expression: string, where: string): string | null {
  const { items: list } = items(src, open);
  const entry = list.find((item) => item.key === "extensions");
  if (!entry) return append(src, open, `extensions: [${expression}]`);
  if (entry.valueStart === entry.start) throw new SchemaEditError(`${where} names its extensions elsewhere (\`extensions\` shorthand); add ${expression} there.`);
  if (src[entry.valueStart] !== "[" || matching(src, entry.valueStart) !== entry.end - 1) {
    throw new SchemaEditError(`${where}: extensions is not written as [ ... ]; add ${expression} to it.`);
  }
  const existing = items(src, entry.valueStart).items.map((item) => squash(src.slice(item.start, item.end)));
  if (existing.includes(squash(expression))) return null;
  return append(src, entry.valueStart, expression);
}

/** Adds the import lines that are missing, after the last import. */
export function addImports(src: string, imports: readonly string[]): string {
  const missing = imports.filter((line) => !src.split("\n").some((l) => l.trim() === line.trim()));
  if (missing.length === 0) return src;
  const lines = src.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\s/.test(lines[i]!)) continue;
    let j = i;
    while (j < lines.length && !/(\bfrom\s*["'][^"']+["']|^import\s*["'][^"']+["'])\s*;?\s*$/.test(lines[j]!)) j++;
    insertAt = j + 1;
    i = j;
  }
  lines.splice(insertAt, 0, ...missing);
  return lines.join("\n");
}

/**
 * The schema file with `expression` among `schema()`'s extensions, or null
 * when it already is. Throws SchemaEditError when the call cannot be read.
 */
export function wireSchemaExtension(src: string, expression: string, imports: readonly string[]): string | null {
  const paren = findCall(src, "schema");
  if (paren === -1) throw new SchemaEditError("No schema( ... ) call found in the schema file.");
  // The arguments, read as the items of a literal: the same text with the parentheses as braces.
  const closeParen = matching(src, paren);
  const shadow = `${src.slice(0, paren)}{${src.slice(paren + 1, closeParen)}}${src.slice(closeParen + 1)}`;
  const args = items(shadow, paren).items;
  let next: string | null;
  if (args.length === 0) throw new SchemaEditError("schema() is called without models.");
  if (args.length === 1) {
    const first = args[0]!;
    const after = first.comma === -1 ? first.end : first.comma + 1;
    next = src.slice(0, first.end) + `, { extensions: [${expression}] }` + src.slice(after);
  } else {
    const options = args[1]!;
    if (src[options.start] !== "{") throw new SchemaEditError(`schema()'s options are built elsewhere; add extensions: [${expression}] to them.`);
    next = addToExtensions(src, options.start, expression, "schema()");
  }
  return next === null ? null : addImports(next, imports);
}

/**
 * The Worker file with `expression` among `defineTapeDB()`'s extensions, or
 * null when it already is. Throws SchemaEditError when the call cannot be read.
 */
export function wireWorkerExtension(src: string, expression: string, imports: readonly string[]): string | null {
  const paren = findCall(src, "defineTapeDB");
  if (paren === -1) throw new SchemaEditError("No defineTapeDB( ... ) call found in the Worker.");
  const open = skipTrivia(src, paren + 1);
  if (src[open] !== "{") throw new SchemaEditError(`defineTapeDB()'s options are built elsewhere; add extensions: [${expression}] to them.`);
  const next = addToExtensions(src, open, expression, "defineTapeDB()");
  return next === null ? null : addImports(next, imports);
}
