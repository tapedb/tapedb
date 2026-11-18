import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, test } from "vitest";
import { resolve } from "node:path";
test("a custom auth browser page is served by the Worker without requiring Studio or server-side React", async () => {
  const bundle = await build({
    stdin: {
      contents: `import {defineTapeDB} from './src/worker';import {schema,model,t} from './src/schema';const app=defineTapeDB({schema:schema({note:model({text:t.string()})}),auth:{handler:async()=>Response.json({auth:true}),api:{getSession:async()=>null}},authPage:{javascript:'document.getElementById("root").textContent="Custom auth"',css:'body{color:purple}'}});export const AuthRoom=app.AuthRoom;export const WorkspaceRoom=app.WorkspaceRoom;export default app.worker;`,
      resolveDir: resolve("."),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-11-18",
      compatibilityFlags: ["nodejs_compat"],
    }),
  );
  try {
    const response = await runtime.dispatchFetch("https://custom.test/auth");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(await response.text()).toContain("/_tapedb/auth/page.js");
    const script = await runtime.dispatchFetch(
      "https://custom.test/_tapedb/auth/page.js",
    );
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("Custom auth");
    expect(
      await (
        await runtime.dispatchFetch("https://custom.test/_tapedb/auth/page.css")
      ).text(),
    ).toContain("purple");
    expect(
      await (
        await runtime.dispatchFetch("https://custom.test/api/auth/get-session")
      ).json(),
    ).toEqual({ auth: true });
  } finally {
    await runtime.dispose();
  }
});
