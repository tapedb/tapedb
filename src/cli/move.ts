import { readFileSync } from "node:fs";
import { mintToken } from "./studio";

export async function moveWorkspaces(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const to = flag("to");
  if (!to || !["none", "eu", "fedramp"].includes(to)) { console.error("Use tapedb move --to none|eu|fedramp --workspace <uuid> or --workspaces <file>."); return 1; }
  const url = (flag("url") ?? "http://localhost:8787").replace(/\/+$/, "");
  const ids = new Set<string>();
  if (flag("workspace")) ids.add(flag("workspace")!);
  if (flag("workspaces")) for (const id of readFileSync(flag("workspaces")!, "utf8").split(/\s+/).filter(Boolean)) ids.add(id);
  if (!ids.size || argv.includes("--discover")) {
    const account = flag("account") ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucket = flag("source-bucket");
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!account || !bucket || !token) { console.error("Discovery needs --account, --source-bucket and CLOUDFLARE_API_TOKEN; alternatively pass workspace ids."); return 1; }
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ prefix: "ws/", delimiter: "/", per_page: "1000", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/objects?${params}`, {
        headers: { authorization: `Bearer ${token}`, "cf-r2-jurisdiction": !flag("from") || flag("from") === "none" ? "default" : flag("from")! },
      });
      const body = await response.json() as { success: boolean; result: Array<{ key: string }>; result_info?: { delimited?: string[]; cursor?: string; is_truncated?: boolean } };
      if (!response.ok || !body.success) throw new Error(`Discovery failed (${response.status}).`);
      for (const key of [...body.result_info?.delimited ?? [], ...body.result.map(object => object.key)]) {
        const id = /^ws\/([^/]+)\//.exec(key)?.[1]; if (id) ids.add(id);
      }
      cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
      if (body.result_info?.is_truncated && !cursor) throw new Error("Discovery ended without its next cursor.");
    } while (cursor);
  }
  const tokens: Record<string, string> = flag("tokens") ? JSON.parse(readFileSync(flag("tokens")!, "utf8")) : {};
  for (const id of ids) {
    const token = tokens[id] ?? process.env.TAPEDB_TOKEN ?? await mintToken(url, id);
    for (let attempt = 0;; attempt++) {
      const response = await fetch(`${url}/engine/workspaces/${encodeURIComponent(id)}/move`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ to }),
      });
      const body = await response.json() as { ok?: boolean; error?: { message?: string; code?: string } };
      if (response.ok && body.ok) { console.log(`Moved ${id} to ${to}; source data removed.`); break; }
      if (attempt >= 300 || (response.status < 500 && body.error?.code !== "workspace_moving")) {
        console.error(`Move ${id} did not finish: ${body.error?.message ?? response.status}. Run the command again to resume.`); return 1;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return 0;
}
