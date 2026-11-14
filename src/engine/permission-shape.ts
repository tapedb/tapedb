/**
 * Shape checks for permission decisions.
 *
 * Kept free of engine imports: `defineSchema` runs in the client entry too,
 * and validating a schema must not pull the engine into a browser bundle.
 */

/** A `{ where }` view rule, recognised structurally. */
export function isViewWhereRule(
  decision: unknown
): decision is { where: (...args: never[]) => unknown } {
  return (
    typeof decision === "object" &&
    decision !== null &&
    typeof (decision as { where?: unknown }).where === "function"
  );
}

/** Throws when a decision is not valid for its action. */
export function assertDecisionShape(
  namespace: string,
  action: string,
  decision: unknown
): void {
  if (typeof decision === "number" || typeof decision === "function") return;
  if (isViewWhereRule(decision)) {
    if (action === "view") return;
    // A where rule on a write would be skipped by the row-rule pass, which
    // only evaluates functions: refusing it here is what keeps it from
    // silently allowing every write.
    throw new Error(
      `"${namespace}.${action}" uses a where rule; where rules are only valid for view.`
    );
  }
  throw new Error(
    `"${namespace}.${action}" must be a role level, a rule function or { where }.`
  );
}
