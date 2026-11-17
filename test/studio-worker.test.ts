/**
 * The studio a deployed Worker serves at /_tapedb/studio, when the app opts in.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import { FONTS } from "../src/studio/fonts.gen";
import { model, schema, t } from "../src/schema";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { studio } = await import("../src/studio/index");

const app = (withStudio: boolean) =>
  defineTapeDB({ schema: schema({ note: model({ body: t.string() }) }), ...(withStudio ? { studio } : {}) });
const env = { DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: "x".repeat(32), ENVIRONMENT: "production" } as never;
const get = (worker: ReturnType<typeof app>, path: string, method = "GET") =>
  worker.worker.fetch(new Request(`https://app.example${path}`, { method }), env, {} as ExecutionContext);

describe("/_tapedb/studio", () => {
  test("the Worker's own address opens it, when the app opts in", async () => {
    const response = await get(app(true), "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example/_tapedb/studio");
    expect((await get(app(true), "/", "POST")).status).toBe(404);
    expect((await get(app(false), "/")).status).toBe(404);
  });

  test("is not there unless the app opts in", async () => {
    expect((await get(app(false), "/_tapedb/studio")).status).toBe(404);
    expect((await get(app(false), "/_tapedb/studio/fonts/inter.woff2")).status).toBe(404);
  });

  test("serves the deployed page, under a policy that runs only its own script and styles", async () => {
    const response = await get(app(true), "/_tapedb/studio");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('var MODE = "worker";');
    expect(html).toContain('url("/_tapedb/studio/fonts/inter.woff2")');
    const csp = response.headers.get("content-security-policy")!;
    const hash = (tag: string) => {
      const inner = html.slice(html.indexOf(`<${tag}>`) + tag.length + 2, html.indexOf(`</${tag}>`));
      return createHash("sha256").update(inner).digest("base64");
    };
    expect(csp).toContain(`script-src 'sha256-${hash("script")}'`);
    expect(csp).toContain(`style-src 'sha256-${hash("style")}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    // One script, one style element, no inline style attributes: the hashes cover everything.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  test("serves the fonts, and nothing else", async () => {
    const worker = app(true);
    for (const name of ["space-grotesk", "inter", "jetbrains-mono"]) {
      const response = await get(worker, `/_tapedb/studio/fonts/${name}.woff2`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4))).toBe("wOF2");
    }
    for (const path of ["/_tapedb/studio/fonts/constructor", "/_tapedb/studio/fonts/__proto__", "/_tapedb/studio/fonts/../claim", "/_tapedb/studio/api/schema"]) {
      expect((await get(worker, path)).status).toBe(404);
    }
    expect((await get(worker, "/_tapedb/studio", "POST")).status).toBe(405);
  });
});

test("the compiled fonts are the fonts in assets/fonts", () => {
  for (const name of ["space-grotesk", "inter", "jetbrains-mono"]) {
    expect(FONTS[`${name}.woff2`]).toBe(readFileSync(`assets/fonts/${name}.woff2`).toString("base64"));
  }
});
