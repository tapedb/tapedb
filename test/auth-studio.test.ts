import { expect, test } from "bun:test";
import { Script } from "node:vm";
import { USERS_PAGE } from "../src/studio/users-page";
import { studioPage } from "../src/studio/page";
import { studio } from "../src/studio";
test("both Studio modes and the Users page contain syntactically valid scripts", () => {
  for (const page of [
    USERS_PAGE,
    studioPage(50, "worker"),
    studioPage(50, "local"),
  ]) {
    const script = page.slice(
      page.indexOf("<script>") + 8,
      page.indexOf("</script>"),
    );
    expect(() => new Script(script)).not.toThrow();
  }
});
test("Users page is served with its own script hash and no inline handlers", async () => {
  const response = await studio.serve(
    new Request("https://studio.test/_tapedb/studio/users"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'sha256-",
  );
  const page = await response.text();
  expect(page).toContain("Welcome back.");
  expect(page).not.toMatch(/\sonclick=/);
});
