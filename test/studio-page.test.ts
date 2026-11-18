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

test("the field form offers an enum and a default that fits the type", () => {
  // The three pieces that make an enum editable: the type in the list, a values
  // input, and a default control that is a list rather than a text box.
  expect(PAGE).toContain('["enum", "One of a set"]');
  expect(PAGE).toContain('textField("f-values"');
  expect(PAGE).toContain("function defaultControl(");
  expect(PAGE).toContain('kind === "boolean"');
  expect(PAGE).toContain('kind === "enum"');
});
