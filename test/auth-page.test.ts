import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareAuthPage } from "../src/cli/auth-page";
import { serveAuthPage, type TapeDBAuthPage } from "../src/auth/page";
const projects: string[] = [];
afterEach(() => {
  for (const root of projects.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function project(react = false) {
  const root = mkdtempSync(join(tmpdir(), "tapedb-auth-ui-"));
  projects.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  if (react)
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  return root;
}
function generated(root: string) {
  return readFileSync(join(root, "tapedb/auth-page.gen.ts"), "utf8");
}
test("a project without the convention keeps the built-in page without loading React or a bundler", async () => {
  const root = project();
  await (await prepareAuthPage(root)).close();
  expect(generated(root)).toContain("= undefined;");
});
test("tapedb.auth.tsx bundles a default React component and local CSS for the browser", async () => {
  const root = project(true);
  writeFileSync(
    join(root, "tapedb.auth.tsx"),
    'import "./auth.css";export default function Auth({redirectTo}:{redirectTo:string}){return <h1 data-return={redirectTo}>Custom company sign-in</h1>;}',
  );
  writeFileSync(join(root, "auth.css"), "h1{color:rebeccapurple}");
  await (await prepareAuthPage(root)).close();
  const source = generated(root);
  expect(source).toContain("Custom company sign-in");
  expect(source).toContain('\"css\"');
  expect(source).toContain("#639");
  expect(source).toContain(".origin===location.origin");
  expect(source).not.toContain("cloudflare:workers");
});
test("an invalid custom page fails the build instead of deploying a silent fallback", async () => {
  const root = project(true);
  writeFileSync(
    join(root, "tapedb.auth.tsx"),
    "export default function Broken( {",
  );
  await expect(prepareAuthPage(root)).rejects.toThrow();
});
test("dev watches imported CSS and restores the built-in page when the convention is removed", async () => {
  const root = project(true);
  const file = join(root, "tapedb.auth.tsx");
  writeFileSync(
    file,
    'import "./auth.css";export default function Auth(){return <h1>Custom</h1>;}',
  );
  writeFileSync(join(root, "auth.css"), "h1{color:red}");
  const context = await prepareAuthPage(root, true);
  try {
    writeFileSync(join(root, "auth.css"), "h1{color:blue}");
    for (let i = 0; i < 150 && !generated(root).includes("blue"); i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generated(root)).toContain("blue");
    rmSync(file);
    for (let i = 0; i < 150 && !generated(root).includes("= undefined;"); i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generated(root)).toContain("= undefined;");
  } finally {
    await context.close();
  }
});
test("custom page assets use an external module and an HTML-escaped title under a separate CSP", async () => {
  const page: TapeDBAuthPage = {
    javascript: 'console.log("</script>")',
    css: "body{color:red}",
    title: "<Custom & auth>",
  };
  const response = serveAuthPage(new Request("https://auth.test/auth"), page)!;
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'self'",
  );
  const html = await response.text();
  expect(html).toContain("&lt;Custom &amp; auth&gt;");
  expect(html).not.toContain("console.log");
  const js = serveAuthPage(
    new Request("https://auth.test/_tapedb/auth/page.js"),
    page,
  )!;
  expect(await js.text()).toBe(page.javascript);
  expect(js.headers.get("x-content-type-options")).toBe("nosniff");
  expect(
    serveAuthPage(
      new Request("https://auth.test/auth", { method: "POST" }),
      page,
    )!.status,
  ).toBe(405);
  expect(
    serveAuthPage(new Request("https://auth.test/api/auth/get-session"), page),
  ).toBeNull();
});

test("the bundled React page renders and receives only a same-origin redirect target", async () => {
  const root = project(true);
  writeFileSync(
    join(root, "tapedb.auth.tsx"),
    "export default function Auth({redirectTo}:{redirectTo:string}){return <h1 data-return={redirectTo}>Your own React auth page</h1>;}",
  );
  await (await prepareAuthPage(root)).close();
  const source = generated(root);
  const bundle = JSON.parse(
    source
      .slice(source.indexOf(" = ") + 3)
      .trim()
      .slice(0, -1),
  ) as TapeDBAuthPage;
  for (const [query, target] of [
    ["https://untrusted.test", "/_tapedb/studio"],
    ["/dashboard?tab=one", "/dashboard?tab=one"],
  ]) {
    const window = new Window({
      url: "https://auth.test/auth?returnTo=" + encodeURIComponent(query),
    });
    try {
      window.document.body.innerHTML = '<div id="root"></div>';
      window.eval(bundle.javascript);
      for (let i = 0; i < 100 && !window.document.querySelector("h1"); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(window.document.querySelector("h1")?.textContent).toBe(
        "Your own React auth page",
      );
      expect(
        window.document.querySelector("h1")?.getAttribute("data-return"),
      ).toBe(target);
    } finally {
      await window.happyDOM.close();
    }
  }
});
