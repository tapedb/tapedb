/**
 * The public API is frozen: this fails whenever an export, a signature, a
 * type the API refers to, the CLI usage or an error code changes without
 * being recorded. A deliberate change updates API.md and the CHANGELOG, then
 * records the new surface with `bun run api:update`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { currentSurface, ENTRIES, SURFACE_FILE, type Surface } from "../scripts/api-surface";

describe("public API surface", () => {
  const recorded = JSON.parse(readFileSync(SURFACE_FILE, "utf8")) as Surface;
  const current = currentSurface();

  test("matches api/surface.json (run `bun run api:update` after documenting a deliberate change)", () => {
    expect(current).toEqual(recorded);
  });

  test("covers every package entry point but the CLI binary", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };
    const exported = Object.keys(pkg.exports).map((key) => (key === "." ? "@tapedb/tapedb" : `@tapedb/tapedb/${key.slice(2)}`));
    expect(exported.sort()).toEqual(Object.keys(ENTRIES).sort());
  });

  test("marks the experimental parts", () => {
    expect(current.entries["@tapedb/tapedb/react"].useBroadcast.experimental).toBe(true);
    expect(current.entries["@tapedb/tapedb"].BroadcastTopic.experimental).toBe(true);
    const model = current.entries["@tapedb/tapedb"].ModelClient.shape as Record<string, string>;
    expect(model.aggregate).toContain("@experimental");
    expect(model.groupBy).toContain("@experimental");
    expect(model.findMany).not.toContain("@experimental");
  });

  test("keeps vector search out of the experimental set", () => {
    const model = current.entries["@tapedb/tapedb"].ModelClient.shape as Record<string, string>;
    expect(model.search).not.toContain("@experimental");
    const options = current.entries["@tapedb/tapedb/worker"].DefineTapeDBOptions.shape as Record<string, string>;
    expect(options.vectorize).not.toContain("@experimental");
    expect(options.vectorize).toContain("VectorizeOptions");
  });

  test("tags no vector or search type experimental", () => {
    const tagged: string[] = [];
    for (const [entry, exported] of Object.entries(current.entries as Record<string, Record<string, unknown>>)) {
      for (const [name, value] of Object.entries(exported)) {
        if (!/^Vector|^Search/.test(name)) continue;
        const flagged = (value as { experimental?: boolean } | null)?.experimental === true;
        if (flagged || JSON.stringify(value).includes("@experimental")) tagged.push(`${entry} ${name}`);
      }
    }
    expect(tagged).toEqual([]);
  });

  test("keeps server internals out of @tapedb/tapedb/worker", () => {
    for (const internal of ["TRUSTED_CLAIM_HEADER", "encodeTrustedRoleClaim", "authenticateEngineRequest", "extractClaimToken", "mintDevClaim", "mintClaim", "WorkspaceRoom"]) {
      expect(current.entries["@tapedb/tapedb/worker"][internal]).toBeUndefined();
    }
    expect(current.entries["@tapedb/tapedb"].Env).toBeUndefined();
  });
});
