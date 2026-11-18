import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { USERS_PAGE } from "../src/studio/users-page";
async function page(url = "https://auth.test/auth") {
  const window = new Window({ url });
  const requests: Array<{ url: string; body: unknown }> = [];
  window.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === "/api/auth/get-session")
      return new window.Response("null", {
        headers: { "content-type": "application/json" },
      });
    if (url === "/_tapedb/dev/emails")
      return new window.Response("", { status: 404 });
    return new window.Response("{}", {
      headers: { "content-type": "application/json" },
    });
  }) as never;
  window.document.write(USERS_PAGE.replace(/<script>[\s\S]*<\/script>/, ""));
  window.eval(USERS_PAGE.split("<script>")[1].split("</script>")[0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window, requests };
}
test("default sign-in asks only for email and moves to a confirmation screen", async () => {
  const { window, requests } = await page();
  try {
    const $ = (id: string) => window.document.getElementById(id)!;
    expect($("password-field").hidden).toBe(true);
    expect($("name-field").hidden).toBe(true);
    ($("email") as unknown as HTMLInputElement).value = "reader@local.test";
    $("login").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      requests.find((r) => r.url === "/api/auth/sign-in/magic-link")?.body,
    ).toMatchObject({ email: "reader@local.test" });
    expect($("email-sent").hidden).toBe(false);
    expect($("signin").hidden).toBe(true);
  } finally {
    await window.happyDOM.close();
  }
});
test("password, sign-up and reset are separate focused states", async () => {
  const { window } = await page();
  try {
    const $ = (id: string) => window.document.getElementById(id)!;
    $("magic").click();
    expect($("password-field").hidden).toBe(false);
    expect($("name-field").hidden).toBe(true);
    $("signup").click();
    expect($("name-field").hidden).toBe(false);
    expect($("auth-title").textContent).toBe("Make yourself at home.");
    $("signup").click();
    $("reset").click();
    expect($("password-field").hidden).toBe(true);
    expect($("continue-label").textContent).toBe("Send reset link");
  } finally {
    await window.happyDOM.close();
  }
});
test("email callbacks cannot redirect to a different origin", async () => {
  const { window, requests } = await page(
    "https://auth.test/auth?returnTo=https://malicious.test",
  );
  try {
    (
      window.document.getElementById("email") as unknown as HTMLInputElement
    ).value = "reader@local.test";
    window.document
      .getElementById("login")!
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      requests.find((r) => r.url === "/api/auth/sign-in/magic-link")?.body,
    ).toMatchObject({ callbackURL: "https://auth.test/_tapedb/studio/users" });
  } finally {
    await window.happyDOM.close();
  }
});
