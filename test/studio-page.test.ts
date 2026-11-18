/**
 * The studio is one HTML string with one inline script, and nothing type-checks
 * that script: a stray bracket ships a blank page. Parsing it here catches that
 * before anyone opens the browser.
 */

import { expect, test } from "bun:test";
import { studioPage } from "../src/studio/page";

const PAGE = studioPage(25, "local");

test("the studio page carries a script that parses", () => {
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  expect(scripts.length).toBe(1);
  // `new Function` compiles without running, so this is a syntax check only.
  expect(() => new Function(scripts[0] as string)).not.toThrow();
});

test("the default control is a list for a closed set and a number for a number", () => {
  // The shipped function, not a copy of it: pulled out of the page and run with
  // just enough DOM to see what it builds.
  const source = /function defaultControl\([\s\S]*?\n}/.exec(PAGE)?.[0];
  expect(source).toBeDefined();
  const shims = `
    function el(tag, attrs) { return { tag: tag, id: attrs && attrs.id, type: attrs && attrs.type, children: [] }; }
    function textField(id, label, value, note, type) {
      return { tag: "div", children: [{ tag: "input", id: id, type: type || "text" }] };
    }
    function selectField(id, label, options, value) {
      return { tag: "div", children: [{ tag: "select", id: id, options: options.map(function (o) { return o[0]; }), value: value }] };
    }
  `;
  const build = new Function(`${shims}${source}; return defaultControl;`)() as (
    kind: string,
    current: string,
    values: string[]
  ) => { children: Array<{ tag: string; type?: string; options?: string[]; value?: string }> };

  const boolean = build("boolean", "true", []).children[0]!;
  expect(boolean.tag).toBe("select");
  expect(boolean.options).toEqual(["", "true", "false"]);
  expect(boolean.value).toBe("true");

  const fromEnum = build("enum", "business", ["retail", "business"]).children[0]!;
  expect(fromEnum.tag).toBe("select");
  expect(fromEnum.options).toEqual(["", "retail", "business"]);

  const number = build("number", "3", []).children[0]!;
  expect(number.tag).toBe("input");
  expect(number.type).toBe("number");

  const text = build("string", "hi", []).children[0]!;
  expect(text.tag).toBe("input");
  expect(text.type).toBe("text");
});

test("the form draws its own controls instead of the system's", () => {
  // A native select opens the OS menu and a native checkbox is the OS's box:
  // neither follows the brand. Both are replaced, with the real input kept for
  // the checkbox so .checked and change still work.
  expect(PAGE).not.toContain('el("select"');
  expect(PAGE).toContain("listbox-option");
  expect(PAGE).toContain('"aria-haspopup": "listbox"');
  expect(PAGE).toContain('el("span", { class: "box", "aria-hidden": "true" })');
  expect(PAGE).toContain(".check input:checked + .box");
});

test("the field form offers an enum and a default that fits the type", () => {
  // The three pieces that make an enum editable: the type in the list, a values
  // input, and a default control that is a list rather than a text box.
  expect(PAGE).toContain('["enum", "One of a set"]');
  expect(PAGE).toContain('textField("f-values"');
  expect(PAGE).toContain("function defaultControl(");
  expect(PAGE).toContain('kind === "boolean"');
  expect(PAGE).toContain('kind === "enum"');
});
