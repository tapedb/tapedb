/** A browser bundle generated from tapedb.auth.tsx. React stays in the browser. */
export interface TapeDBAuthPage {
  javascript: string;
  css?: string;
  title?: string;
}
const PREFIX = "/_tapedb/auth/page";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
/** Serve only the generated public page and its assets, never auth server code. */
export function serveAuthPage(
  request: Request,
  page: TapeDBAuthPage,
): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== "/auth" && path !== PREFIX + ".js" && path !== PREFIX + ".css")
    return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  const headers = new Headers({
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  let body: string;
  if (path === PREFIX + ".js") {
    headers.set("content-type", "application/javascript; charset=utf-8");
    body = page.javascript;
  } else if (path === PREFIX + ".css") {
    headers.set("content-type", "text/css; charset=utf-8");
    body = page.css ?? "";
  } else {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    body =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      escape(page.title ?? "Sign in") +
      "</title>" +
      (page.css ? '<link rel="stylesheet" href="' + PREFIX + '.css">' : "") +
      '</head><body><div id="root"></div><script type="module" src="' +
      PREFIX +
      '.js"></script></body></html>';
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
