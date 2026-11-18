import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, test } from "vitest";
import { resolve } from "node:path";
test("existing workspace adoption seeds the explicit owner once and keeps old data untouched", async () => {
  const bundle = await build({
    entryPoints: ["scripts/auth/adoption-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
    conditions: ["workerd", "worker", "browser"],
    alias: {
      "@tapedb/tapedb/auth": resolve("src/auth/index.ts"),
      "@tapedb/tapedb/email": resolve("src/email/index.ts"),
      "@tapedb/tapedb/worker": resolve("src/worker/index.ts"),
      "@tapedb/tapedb/studio": resolve("src/studio/index.ts"),
      "@tapedb/tapedb/schema": resolve("src/schema-entry.ts"),
    },
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-11-18",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        AUTH: { className: "AuthRoom", useSQLite: true },
        WORKSPACE: { className: "WorkspaceRoom", useSQLite: true },
      },
      r2Buckets: ["DATA", "FILES"],
      bindings: {
        ENVIRONMENT: "production",
        BETTER_AUTH_SECRET:
          "test-only-auth-secret-at-least-thirty-two-characters",
        TAPEDB_CLAIM_SECRET:
          "test-only-claim-secret-at-least-thirty-two-characters",
        TAPEDB_KEY_SECRET:
          "test-only-key-secret-at-least-thirty-two-characters",
        EMAIL_FROM: "no-reply@local.test",
      },
    }),
  );
  try {
    const bucket = await runtime.getR2Bucket("DATA");
    const workspace = crypto.randomUUID();
    await bucket.put("ws/" + workspace + "/existing-data.txt", "preserved");
    const inspect = async () => {
      const r = await runtime.dispatchFetch(
        "https://adoption.test/_test/adoption",
      );
      expect(r.status, await r.clone().text()).toBe(200);
      return (await r.json()) as {
        owner: { id: string; emailVerified: boolean };
        workspaces: Array<{ id: string; role: number }>;
      };
    };
    const first = await inspect();
    expect(first.owner.emailVerified).toBe(false);
    expect(first.workspaces).toEqual([{ id: workspace, role: 6 }]);
    const second = await inspect();
    expect(second.owner.id).toBe(first.owner.id);
    expect(second.workspaces).toEqual(first.workspaces);
    expect(
      await (await bucket.get(
        "ws/" + workspace + "/existing-data.txt",
      ))!.text(),
    ).toBe("preserved");
    expect(
      (
        await runtime.dispatchFetch("https://adoption.test/_tapedb/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: workspace }),
        })
      ).status,
    ).toBe(401);
  } finally {
    await runtime.dispose();
  }
});
