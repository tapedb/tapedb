/**
 * Test fixture: a large, realistic schema the engine was first built against.
 *
 * The upstream suite asserts against these namespaces, so the fixture installs
 * them into the engine registry before each file's tests run. Production code
 * never imports this; it is a contract fixture, not a dependency.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { WORKSPACE_ROLE_LEVELS } from "../../src/claims";
import { configureMigrations } from "../../src/engine/migrations-bundle";
import { configureRegistry } from "../../src/engine/registry";
import { configurePermissions } from "../../src/engine/tx-permissions";
import {
  LINKS as LEGACY_LINKS,
  NAMESPACES as LEGACY_NAMESPACES,
} from "./legacy-registry";

export * from "../../src/engine/registry";

const MIGRATIONS_DIR = resolve(import.meta.dir, "migrations");

/** The fixture SQL the room applies on boot, in id order. */
const FIXTURE_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => ({
    id: file.replace(/\.sql$/, ""),
    sql: readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"),
  }));

/** Installs the legacy schema. Safe to call repeatedly. */
export function useLegacyFixture(): void {
  configureRegistry({
    namespaces: Object.values(LEGACY_NAMESPACES),
    links: Object.values(LEGACY_LINKS),
  });
  configureMigrations(FIXTURE_MIGRATIONS);
  configurePermissions({
    overrides: {
      kanbanAttachments: { delete: WORKSPACE_ROLE_LEVELS.EDITOR },
      taskAssignees: {
        create: WORKSPACE_ROLE_LEVELS.EDITOR,
        update: WORKSPACE_ROLE_LEVELS.EDITOR,
        delete: WORKSPACE_ROLE_LEVELS.EDITOR,
      },
    },
  });
}

useLegacyFixture();
