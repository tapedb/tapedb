/**
 * Bundled workspace migrations.
 *
 * The deployment's SQL is generated from its schema by `tapedb generate` and
 * bundled as this module's contents. The list is mutated in place by
 * `configureMigrations()` so `migrations.ts` can keep its default-argument
 * shape while still receiving the deployment's migrations.
 */

export interface BundledWorkspaceMigration {
  id: string;
  sql: string;
}

/** Configured migrations, applied in order on Durable Object boot. */
export const WORKSPACE_MIGRATIONS: BundledWorkspaceMigration[] = [];

/** Installs the deployment's bundled migrations. Called once per instance. */
export function configureMigrations(
  migrations: readonly BundledWorkspaceMigration[]
): void {
  WORKSPACE_MIGRATIONS.length = 0;
  WORKSPACE_MIGRATIONS.push(...migrations);
}
