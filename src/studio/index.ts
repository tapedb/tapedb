/**
 * `@tapedb/tapedb/studio`: the studio, served by the deployed Worker at
 * /_tapedb/studio. It signs in the way the app does (POST /_tapedb/claim with
 * the app's own session), so the identity decides the role, and every read
 * and write goes through the same access rules as the app's.
 *
 * Opt in from worker.ts: `defineTapeDB({ schema, migrations, studio })`.
 * Importing it adds the page and its fonts to the Worker; leaving it out adds
 * nothing.
 */

import { FONTS } from "./fonts.gen";
import { studioPage } from "./page";

export interface TapeDBStudio {
  /** Answers a request under /_tapedb/studio. */
  serve(request: Request): Promise<Response>;
}

const PREFIX = "/_tapedb/studio";
const PAGE_LIMIT = 50;

let page: { html: string; csp: string } | null = null;

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function inner(html: string, tag: string): string {
  const open = html.indexOf(`<${tag}>`) + tag.length + 2;
  return html.slice(open, html.indexOf(`</${tag}>`, open));
}

/** The page, and a policy that runs only its own script and styles. */
async function pageWithPolicy(): Promise<{ html: string; csp: string }> {
  if (page) return page;
  const html = studioPage(PAGE_LIMIT, "worker");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${await sha256(inner(html, "script"))}'`,
    `style-src 'sha256-${await sha256(inner(html, "style"))}'`,
    "font-src 'self'",
    "connect-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  page = { html, csp };
  return page;
}

function fontBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

export const studio: TapeDBStudio = {
  async serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (path === PREFIX || path === `${PREFIX}/`) {
      const { html, csp } = await pageWithPolicy();
      return new Response(request.method === "HEAD" ? null : html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }
    const name = path.startsWith(`${PREFIX}/fonts/`) ? path.slice(`${PREFIX}/fonts/`.length) : "";
    const font = Object.hasOwn(FONTS, name) ? FONTS[name] : undefined;
    if (font) {
      return new Response(request.method === "HEAD" ? null : fontBytes(font), {
        headers: { "content-type": "font/woff2", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
