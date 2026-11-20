/**
 * `npm pack --json` answers with an array of packs on npm 11 and with an object
 * keyed by package name on npm 12. Both are the same information, so both gates
 * that read it go through here rather than each guessing.
 */

/** The packed entries, newest npm shape or oldest. */
export function packedEntries(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (entries.length === 0 || entries.some((entry) => entry === null || typeof entry !== "object")) {
    throw new Error(`npm pack --json answered with no package: ${stdout.slice(0, 200)}`);
  }
  return entries;
}

/** The tarball's file name. */
export function packedArchive(stdout) {
  const [entry] = packedEntries(stdout);
  if (typeof entry.filename !== "string" || entry.filename === "") {
    throw new Error(`npm pack --json answered without a filename: ${stdout.slice(0, 200)}`);
  }
  return entry.filename;
}
