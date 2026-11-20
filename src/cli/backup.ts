/**
 * `tapedb backup` and `tapedb restore`: a workspace as a directory on disk.
 *
 * A backup is the export the engine already streams, plus the bytes of every
 * file it names, plus a manifest that says what the directory holds:
 *
 *   <dir>/backup.json              format, version, workspace, counts, sha256 per part
 *   <dir>/rows.ndjson              the export records, verbatim
 *   <dir>/files/<path>             the bytes of each `file` record, as stored
 *
 * Nothing here is a second export path: `backup` calls `GET …/export` and
 * writes the bytes it receives untouched, and `restore` posts the rows back
 * through `POST …/import`, the route `tapedb move` uses. File bytes go back
 * through the file route, so the index is rebuilt for the destination
 * workspace and the R2 keys recorded in the export are never reused.
 *
 * Restore verifies every part before it writes anything, and refuses a
 * destination that is not empty. Running it twice is therefore a clean error,
 * not a silent second copy: the first restore's data is left alone.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseFlags } from "./flags";
import { mintToken } from "./studio";

/** What `backup.json` says it is; a restore refuses anything else. */
export const BACKUP_FORMAT = "tapedb-backup";
export const BACKUP_VERSION = 1;

/** One hashed piece of the directory: the export, or one file's bytes. */
interface BackupPart {
  /** Path inside the backup directory, `/`-separated. */
  path: string;
  kind: "rows" | "file";
  bytes: number;
  sha256: string;
  /** Present for `file` parts: the index record the bytes belong to. */
  file?: { path: string; id: string; size: number; contentType: string | null };
}

interface BackupManifest {
  format: string;
  version: number;
  createdAt: string;
  workspaceId: string;
  seq: number;
  rows: number;
  counts: Record<string, number>;
  models: string[];
  schemaVersion: string | null;
  consistent: true;
  parts: BackupPart[];
}

interface ExportFileLine {
  id: string;
  path: string;
  size: number;
  contentType: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--token`, then TAPEDB_TOKEN, then the dev claim route (as export and erase do). */
async function claimFor(url: string, workspace: string, token: string | undefined): Promise<string> {
  return token || process.env.TAPEDB_TOKEN || (await mintToken(url, workspace));
}

function engine(url: string, workspace: string, path: string): string {
  return `${url}/engine/workspaces/${encodeURIComponent(workspace)}${path}`;
}

/** A `/`-separated relative path, or a refusal: a backup never writes outside its directory. */
function partPath(root: string, relative: string): string {
  const clean = relative.replace(/\\/g, "/");
  const segments = clean.split("/");
  if (!clean || clean.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Refusing the path ${JSON.stringify(relative)}: a backup holds plain relative paths.`);
  }
  return join(root, ...segments);
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const handle = openSync(path, "r");
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(handle);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} B` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function short(hash: string): string {
  return hash.slice(0, 16);
}

/**
 * Writes `<out>/backup.json`, `<out>/rows.ndjson` and `<out>/files/<path>`.
 *
 * The export is written as it arrives, so the saved records are the engine's
 * own bytes. It must be consistent: a backup of a workspace that changed
 * mid-export is refused, because import would refuse it too.
 *
 * `--dry-run` reads and hashes the same records and writes nothing: not the
 * directory, not a partial file.
 */
export async function backupWorkspace(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const url = (typeof flags.url === "string" ? flags.url : "http://localhost:8787").replace(/\/+$/, "");
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.env.TAPEDB_WORKSPACE ?? "";
  const outFlag = typeof flags.out === "string" ? flags.out : "";
  const dryRun = flags["dry-run"] === true || flags.dryRun === true;

  if (!workspace || !UUID.test(workspace)) {
    console.error("Name the workspace: tapedb backup --workspace <uuid> --out <dir> [--url <worker>] [--token <claim>]. TAPEDB_WORKSPACE also works.");
    return 1;
  }
  if (!outFlag) {
    console.error("Name the directory to write: tapedb backup --workspace <uuid> --out <dir>.");
    return 1;
  }

  const out = resolve(outFlag);
  const manifestPath = join(out, "backup.json");
  if (!dryRun && existsSync(manifestPath)) {
    console.error(`${out} already holds a backup (${manifestPath}). Restore it or choose another directory.`);
    return 1;
  }

  // Everything this run puts on disk, removed again if it does not finish.
  const created: string[] = [];
  try {
    const token = await claimFor(url, workspace, typeof flags.token === "string" ? flags.token : undefined);
    const response = await fetch(engine(url, workspace, "/export"), { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok || !response.body) {
      console.error(`Export failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return 1;
    }

    const rowsPath = join(out, "rows.ndjson");
    if (!dryRun) mkdirSync(out, { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    const seen: {
      header?: { workspaceId?: unknown; seq?: unknown; models?: unknown; schemaVersion?: unknown };
      end?: { rows?: unknown; counts?: unknown; seq?: unknown; consistent?: unknown };
    } = {};
    const files: ExportFileLine[] = [];
    const readRecord = (line: string) => {
      if (!line.trim()) return;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "header") {
        if (value.format !== "tapedb-export" || value.version !== 1 || value.workspaceId !== workspace) {
          throw new Error("The engine answered with an export this CLI cannot read.");
        }
        seen.header = value;
      } else if (value.type === "end") {
        seen.end = value;
      } else if (value.type === "error") {
        throw new Error(`Export stopped early: ${String(value.message ?? "the engine reported an error")}. Nothing was backed up.`);
      } else if (value.type === "file") {
        const file = value.file as ExportFileLine | undefined;
        if (!file || typeof file.path !== "string" || typeof file.id !== "string" || !Number.isSafeInteger(file.size)) {
          throw new Error("The export carried a file record this CLI cannot read.");
        }
        files.push(file);
      }
    };

    // One pass over the stream: hash it, write it unless this is a dry run,
    // and read the records out of the same bytes, so a large export is never
    // held in memory.
    const decoder = new TextDecoder();
    let tail = "";
    const handle = dryRun ? null : openSync(rowsPath, "w");
    if (handle !== null) created.push(rowsPath);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        bytes += value.byteLength;
        if (handle !== null) writeSync(handle, value);
        tail += decoder.decode(value, { stream: true });
        for (let at = tail.indexOf("\n"); at >= 0; at = tail.indexOf("\n")) {
          readRecord(tail.slice(0, at));
          tail = tail.slice(at + 1);
        }
      }
      tail += decoder.decode();
      readRecord(tail);
    } finally {
      if (handle !== null) closeSync(handle);
    }
    const header = seen.header;
    const end = seen.end;
    if (!header || !end || end.consistent !== true) {
      throw new Error(!end ? "The export ended without its end line; nothing was backed up."
        : "Writes landed while this workspace was being exported, so the copy is not a single point in time. Run backup again.");
    }

    const parts: BackupPart[] = [{ path: "rows.ndjson", kind: "rows", bytes, sha256: hash.digest("hex") }];
    for (const file of files) {
      const relative = `files/${file.path}`;
      const target = partPath(out, relative);
      const frozen = createHash("sha256");
      let written = 0;
      const response = await fetch(engine(url, workspace, `/files/${file.path.split("/").map(encodeURIComponent).join("/")}`), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok || !response.body) {
        console.error(`Could not read the bytes of ${file.path} (HTTP ${response.status}). A backup needs every file the export names.`);
        return 1;
      }
      let handle: number | null = null;
      if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        handle = openSync(target, "w");
        created.push(target);
      }
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          frozen.update(value);
          written += value.byteLength;
          if (handle !== null) writeSync(handle, value);
        }
      } finally {
        if (handle !== null) closeSync(handle);
      }
      if (written !== file.size) {
        console.error(`${file.path} came back as ${written} bytes; the index says ${file.size}. Run backup again.`);
        return 1;
      }
      parts.push({
        path: relative,
        kind: "file",
        bytes: written,
        sha256: frozen.digest("hex"),
        file: { path: file.path, id: file.id, size: file.size, contentType: file.contentType ?? null },
      });
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      workspaceId: workspace,
      seq: Number(end.seq ?? header.seq ?? 0),
      rows: Number(end.rows ?? 0),
      counts: (end.counts ?? {}) as Record<string, number>,
      models: (header.models ?? []) as string[],
      schemaVersion: typeof header.schemaVersion === "string" ? header.schemaVersion : null,
      consistent: true,
      parts,
    };
    if (dryRun) {
      console.log(`Dry run: workspace ${workspace} at seq ${manifest.seq}: ${manifest.rows} rows, ${files.length} file(s)`);
      console.log(`  rows.ndjson  ${megabytes(parts[0]!.bytes)}  sha256 ${parts[0]!.sha256}`);
      for (const part of parts.slice(1)) console.log(`  ${part.path}  ${megabytes(part.bytes)}  sha256 ${part.sha256}`);
      console.log(`Nothing was written: ${out} is untouched.`);
      return 0;
    }

    // Written last: a directory without it is an interrupted backup, and
    // restore refuses those.
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`Backed up workspace ${workspace} to ${out}`);
    console.log(`  ${manifest.rows} rows at seq ${manifest.seq}, ${files.length} file(s), ${megabytes(parts.reduce((sum, part) => sum + part.bytes, 0))}`);
    console.log(`  rows.ndjson  sha256 ${short(parts[0]!.sha256)}  (${megabytes(parts[0]!.bytes)})`);
    for (const part of parts.slice(1)) console.log(`  ${part.path}  sha256 ${short(part.sha256)}  (${megabytes(part.bytes)})`);
    return 0;
  } catch (error) {
    // A refused or interrupted run leaves no half-backup to mistake for one.
    for (const path of created) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Reads `backup.json` and checks every part against its recorded sha256 and
 * length. Throws on the first part that does not match, naming it: nothing
 * may be written before this passes.
 */
function readVerifiedManifest(root: string): { manifest: BackupManifest; verified: Array<{ part: BackupPart; sha256: string }> } {
  const manifestPath = join(root, "backup.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${root} has no backup.json. Point --from at a directory \`tapedb backup\` wrote.`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (error) {
    throw new Error(`backup.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error(`backup.json is ${JSON.stringify(manifest?.format)} version ${String(manifest?.version)}; this CLI restores ${BACKUP_FORMAT} version ${BACKUP_VERSION}.`);
  }
  if (typeof manifest.workspaceId !== "string" || !UUID.test(manifest.workspaceId) || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new Error("backup.json is missing its workspace or its parts.");
  }
  const verified: Array<{ part: BackupPart; sha256: string }> = [];
  for (const part of manifest.parts) {
    const path = partPath(root, part.path);
    if (!existsSync(path)) throw new Error(`${part.path} is missing from the backup.`);
    const hashed = sha256File(path);
    if (hashed.sha256 !== part.sha256 || hashed.bytes !== part.bytes) {
      throw new Error(
        `${part.path} does not match the backup: ${hashed.bytes} bytes, sha256 ${short(hashed.sha256)}; backup.json records ${part.bytes} bytes, sha256 ${short(String(part.sha256))}. Nothing was written.`
      );
    }
    verified.push({ part, sha256: hashed.sha256 });
  }
  if (!verified.some(({ part }) => part.kind === "rows")) throw new Error("backup.json names no rows part.");
  return { manifest, verified };
}

/** The rows of an export without its file records, pointed at the destination workspace. */
function rowsForImport(text: string, destination: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "file") continue;
    if (value.type === "header") lines.push(JSON.stringify({ ...value, workspaceId: destination }));
    else lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Asks the destination what it already holds, reading only as far as the first
 * row or file: a non-empty workspace does not need a full export to answer.
 */
async function inspectDestination(url: string, workspace: string, token: string): Promise<{ empty: boolean; saw: "row" | "file" | null }> {
  const response = await fetch(engine(url, workspace, "/export"), { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 410) throw new Error(`Workspace ${workspace} was erased; a restore needs a workspace that still exists.`);
  if (!response.ok || !response.body) throw new Error(`Could not read workspace ${workspace} (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      tail += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let at = tail.indexOf("\n");
      while (at >= 0) {
        const line = tail.slice(0, at);
        tail = tail.slice(at + 1);
        at = tail.indexOf("\n");
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type === "error") throw new Error(`Workspace ${workspace} could not be read: ${String(record.message ?? "the engine reported an error")}`);
        // One row or one file is enough to know the answer: stop reading.
        if (record.type === "row") return { empty: false, saw: "row" };
        if (record.type === "file") return { empty: false, saw: "file" };
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { empty: true, saw: null };
}

/**
 * Restores a backup into an empty workspace: `--into <uuid>`, or the workspace
 * the backup was taken from.
 *
 * Order: verify every hash, check the destination, import the rows, upload the
 * file bytes. Nothing is written before the first two, so a tampered backup or
 * an occupied destination changes nothing.
 */
export async function restoreWorkspace(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const url = (typeof flags.url === "string" ? flags.url : "http://localhost:8787").replace(/\/+$/, "");
  const fromFlag = typeof flags.from === "string" ? flags.from : "";
  const into = typeof flags.into === "string" ? flags.into : undefined;
  const dryRun = flags["dry-run"] === true || flags["dryRun"] === true;

  if (!fromFlag) {
    console.error("Name the backup directory: tapedb restore --from <dir> [--into <uuid>] [--url <worker>] [--dry-run].");
    return 1;
  }
  const root = resolve(fromFlag);

  let verified: Array<{ part: BackupPart; sha256: string }>;
  let manifest: BackupManifest;
  try {
    ({ manifest, verified } = readVerifiedManifest(root));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const destination = into ?? manifest.workspaceId;
  if (!UUID.test(destination)) {
    console.error(`--into takes a workspace id (a UUID), not ${JSON.stringify(destination)}.`);
    return 1;
  }
  const parts = manifest.parts;
  const rowsPart = parts.find((part) => part.kind === "rows")!;
  const fileParts = parts.filter((part) => part.kind === "file");

  const report = () => {
    console.log(`  ${rowsPart.path}  ${megabytes(rowsPart.bytes)}  sha256 ${short(rowsPart.sha256)}`);
    for (const part of fileParts) console.log(`  ${part.path}  ${megabytes(part.bytes)}  sha256 ${short(part.sha256)}${part.file?.contentType ? `  ${part.file.contentType}` : ""}`);
  };

  if (dryRun) {
    console.log(`Backup of workspace ${manifest.workspaceId} (${manifest.rows} rows at seq ${manifest.seq}, ${fileParts.length} file(s)) would restore into ${destination}:`);
    report();
    console.log("Dry run: every part verified; nothing was written and nothing was sent.");
    return 0;
  }

  try {
    const token = await claimFor(url, destination, typeof flags.token === "string" ? flags.token : undefined);
    const held = await inspectDestination(url, destination, token);
    if (!held.empty) {
      // A clean refusal, deliberately: import needs an empty workspace, so a
      // second restore is an error rather than a silent second copy.
      console.error(
        `Destination ${destination} already holds ${held.saw === "file" ? "files" : "rows"}; a restore needs an empty workspace. ` +
          "Nothing was written. Erase it, or pass --into with another workspace id."
      );
      return 1;
    }

    console.log(`Restoring workspace ${manifest.workspaceId} into ${destination}: ${manifest.rows} rows, ${fileParts.length} file(s).`);
    report();

    const exported = readFileSync(join(root, ...rowsPart.path.split("/")), "utf8");
    const imported = await fetch(engine(url, destination, "/import"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
      body: rowsForImport(exported, destination),
    });
    const result = (await imported.json().catch(() => null)) as { ok?: boolean; imported?: { rows?: number }; error?: { message?: string } } | null;
    if (!imported.ok || !result?.ok) {
      console.error(`Import failed with HTTP ${imported.status}: ${result?.error?.message ?? "no details"}. Nothing was written.`);
      return 1;
    }
    const rows = result.imported?.rows ?? 0;
    if (rows !== manifest.rows) {
      console.error(`Imported ${rows} rows; the backup records ${manifest.rows}. Check the destination with \`tapedb export\`.`);
      return 1;
    }

    for (const part of fileParts) {
      const path = part.file!.path;
      const bytes = readFileSync(join(root, ...part.path.split("/")));
      const uploaded = await fetch(engine(url, destination, `/files/${path.split("/").map(encodeURIComponent).join("/")}`), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": part.file?.contentType ?? "application/octet-stream",
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      });
      if (!uploaded.ok) {
        const detail = (await uploaded.text()).slice(0, 300);
        console.error(
          `Restored ${rows} rows, then ${path} failed to upload (HTTP ${uploaded.status}): ${detail}. ` +
            "The destination holds everything but that file; upload it again or erase the workspace and restore again."
        );
        return 1;
      }
    }

    console.log(`Restored ${rows} rows and ${fileParts.length} file(s) into ${destination} at seq ${manifest.seq}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
