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
    const exported = Object.keys(pkg.exports).map((key) => (key === "." ? "tapedb" : `tapedb/${key.slice(2)}`));
    expect(exported.sort()).toEqual(Object.keys(ENTRIES).sort());
  });

  test("marks the experimental parts", () => {
    expect(current.entries["tapedb/react"].useBroadcast.experimental).toBe(true);
    expect(current.entries.tapedb.BroadcastTopic.experimental).toBe(true);
    const model = current.entries.tapedb.ModelClient.shape as Record<string, string>;
    expect(model.aggregate).toContain("@experimental");
    expect(model.groupBy).toContain("@experimental");
    expect(model.findMany).not.toContain("@experimental");
  });

  test("keeps server internals out of tapedb/worker", () => {
    for (const internal of ["TRUSTED_CLAIM_HEADER", "encodeTrustedRoleClaim", "authenticateEngineRequest", "extractClaimToken", "mintDevClaim", "mintClaim", "WorkspaceRoom"]) {
      expect(current.entries["tapedb/worker"][internal]).toBeUndefined();
    }
    expect(current.entries.tapedb.Env).toBeUndefined();
  });
});
