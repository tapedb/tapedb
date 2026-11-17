/**
 * Reads one client call, `db.<model>.<method>({ ... })`, as written in app
 * code. The arguments are parsed as data, never evaluated: object and array
 * literals, strings, numbers, true, false, null, undefined and
 * `new Date(...)`, with comments and trailing commas allowed.
 */

export interface Call {
  model: string;
  method: string;
  args: unknown;
}

export class CallError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

export function parseCall(source: string): Call {
  let at = 0;

  const fail = (message: string, where = at): never => {
    const before = source.slice(0, where).split("\n");
    throw new CallError(message, before.length, before[before.length - 1].length + 1);
  };

  const space = () => {
    for (;;) {
      while (at < source.length && /\s/.test(source[at])) at++;
      if (source.startsWith("//", at)) {
        while (at < source.length && source[at] !== "\n") at++;
      } else if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2);
        if (end < 0) fail("This comment is never closed.");
        at = end + 2;
      } else {
        return;
      }
    }
  };

  const word = (): string => {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(at));
    return match ? match[0] : "";
  };

  const expect = (text: string, what = `"${text}"`) => {
    space();
    if (!source.startsWith(text, at)) fail(`Expected ${what}.`);
    at += text.length;
  };

  const string = (): string => {
    const quote = source[at];
    const start = at;
    at++;
    let out = "";
    while (at < source.length && source[at] !== quote) {
      if (quote === "`" && source.startsWith("${", at)) fail("Template placeholders are not supported; write the value.");
      if (source[at] === "\n" && quote !== "`") fail("This string is never closed.", start);
      if (source[at] === "\\") {
        const next = source[at + 1];
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
        if (next === "u") {
          const hex = /^u\{([0-9a-fA-F]+)\}|^u([0-9a-fA-F]{4})/.exec(source.slice(at + 1));
          if (!hex) fail("Invalid \\u escape.");
          out += String.fromCodePoint(parseInt(hex![1] ?? hex![2], 16));
          at += 1 + hex![0].length;
          continue;
        }
        out += escapes[next] ?? next;
        at += 2;
        continue;
      }
      out += source[at++];
    }
    if (at >= source.length) fail("This string is never closed.", start);
    at++;
    return out;
  };

  const value = (): unknown => {
    space();
    const char = source[at];
    if (char === undefined) fail("Expected a value.");
    if (char === "{") return object();
    if (char === "[") return array();
    if (char === '"' || char === "'" || char === "`") return string();
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    const name = word();
    if (name === "true" || name === "false") {
      at += name.length;
      return name === "true";
    }
    if (name === "null") {
      at += 4;
      return null;
    }
    if (name === "undefined") {
      at += 9;
      return undefined;
    }
    if (name === "new") {
      at += 3;
      space();
      if (word() !== "Date") fail("Only new Date(...) can be created here.");
      at += 4;
      expect("(");
      space();
      if (source[at] === ")") {
        at++;
        return new Date();
      }
      const start = at;
      const input = value();
      if (typeof input !== "string" && typeof input !== "number") fail("new Date takes a date string or a number.", start);
      expect(")");
      const date = new Date(input as string | number);
      if (Number.isNaN(date.getTime())) fail(`"${String(input)}" is not a date.`, start);
      return date;
    }
    return fail(name ? `"${name}" is not a value here; use literals such as "text", 42, true or new Date("2026-01-01").` : "Expected a value.");
  };

  const object = (): Record<string, unknown> => {
    at++;
    const out: Record<string, unknown> = {};
    for (;;) {
      space();
      if (source[at] === "}") {
        at++;
        return out;
      }
      let key: string;
      const start = at;
      if (source[at] === '"' || source[at] === "'") {
        key = string();
      } else {
        key = word() || (/^\d+/.exec(source.slice(at))?.[0] ?? "");
        if (!key) fail("Expected a field name.");
        at += key.length;
      }
      if (key === "__proto__") fail('"__proto__" is not a field name.', start);
      space();
      if (source[at] === "," || source[at] === "}") {
        fail(`Write "${key}: value"; shorthand fields need variables, which a query here cannot use.`, start);
      }
      expect(":");
      out[key] = value();
      space();
      if (source[at] === ",") {
        at++;
        continue;
      }
      if (source[at] !== "}") fail('Expected "," or "}".');
    }
  };

  const array = (): unknown[] => {
    at++;
    const out: unknown[] = [];
    for (;;) {
      space();
      if (source[at] === "]") {
        at++;
        return out;
      }
      out.push(value());
      space();
      if (source[at] === ",") {
        at++;
        continue;
      }
      if (source[at] !== "]") fail('Expected "," or "]".');
    }
  };

  const name = (what: string): string => {
    space();
    const found = word();
    if (!found) fail(`Expected ${what}.`);
    at += found.length;
    return found;
  };

  space();
  if (word() === "await") {
    at += 5;
  }
  space();
  // `db.` is optional: `task.findMany()` reads the same.
  let first = name("db.<model>.<method>(...)");
  if (first === "db") {
    expect(".");
    first = name("a model name");
  }
  expect(".");
  const method = name("a method, such as findMany");
  expect("(");
  space();
  const args = source[at] === ")" ? undefined : value();
  space();
  if (source[at] === ",") fail("Methods here take one argument.");
  expect(")");
  space();
  if (source[at] === ";") at++;
  space();
  if (at < source.length) fail("Run one call at a time: select it, or remove the rest.");
  return { model: first, method, args };
}
