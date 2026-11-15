import type { Env } from "../types";
import { filesPrefix, manifestKey, workspacePrefix } from "./r2-keys";
import { listAllR2 } from "./r2-list";

export type MoveState = { state: "frozen" | "copying" | "copied" | "ready" | "moved"; to: string };
export const moveKey = (id: string) => `moves/${id}.json`;
export const jurisdiction = (value: string | undefined) => value === "none" || value === "" ? undefined : value;
export async function readMove(bucket: R2Bucket, id: string): Promise<MoveState | null> {
  const object = await bucket.get(moveKey(id));
  return object ? object.json<MoveState>() : null;
}
export async function writeMove(bucket: R2Bucket, id: string, state: MoveState): Promise<void> {
  await bucket.put(moveKey(id), JSON.stringify(state));
}

/** Bindings for the source side of a configured move. */
export function sourceEnvironment(env: Env): Env {
  if (env.TAPEDB_MOVE_FROM === undefined || !env.DATA_FROM) throw new Error("Configure TAPEDB_MOVE_FROM and DATA_FROM before moving workspaces.");
  return { ...env, WORKSPACE: env.WORKSPACE_FROM ?? env.WORKSPACE, DATA: env.DATA_FROM, FILES: env.FILES_FROM,
    TAPEDB_JURISDICTION: jurisdiction(env.TAPEDB_MOVE_FROM), TAPEDB_MOVE_FROM: undefined };
}

/** Copy with bounded memory and R2's equal-sized multipart parts. */
export async function copyObject(from: R2Bucket, to: R2Bucket, key: string): Promise<void> {
  if (await to.head(key)) return;
  const info = await from.head(key);
  if (!info) throw new Error(`Move source object disappeared: ${key}`);
  const metadata = { httpMetadata: info.httpMetadata, customMetadata: info.customMetadata };
  if (info.size <= 8 * 1024 * 1024) {
    const object = await from.get(key);
    if (!object) throw new Error(`Move source object disappeared: ${key}`);
    await to.put(key, object.body, { ...metadata, onlyIf: { etagDoesNotMatch: "*" } }); return;
  }
  // At most 10,000 parts, streamed directly from native R2 range bodies.
  const size = Math.max(8 * 1024 * 1024, Math.ceil(info.size / 10_000));
  const upload = await to.createMultipartUpload(key, metadata);
  const parts: R2UploadedPart[] = [];
  try {
    for (let offset = 0; offset < info.size; offset += size) {
      const object = await from.get(key, { range: { offset, length: Math.min(size, info.size - offset) } });
      if (!object) throw new Error(`Move source object disappeared: ${key}`);
      parts.push(await upload.uploadPart(parts.length + 1, object.body));
    }
    await upload.complete(parts);
  } catch (error) { await upload.abort().catch(() => undefined); throw error; }
}

export async function copyWorkspace(source: Env, target: Env, id: string, fileKeys: ReadableStream<Uint8Array>): Promise<void> {
  const manifest = manifestKey(id);
  const objects = await listAllR2(source.DATA, `${workspacePrefix(id)}/`);
  for (const object of objects) if (object.key !== manifest) await copyObject(source.DATA, target.DATA, object.key);
  const reader = fileKeys.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      tail += decoder.decode(value, { stream: true });
      for (let end = tail.indexOf("\n"); end >= 0; end = tail.indexOf("\n")) {
        const key = JSON.parse(tail.slice(0, end)) as string; tail = tail.slice(end + 1);
        if (!source.FILES || !target.FILES) throw new Error("A FILES binding is missing.");
        if (!key.startsWith(filesPrefix(id))) throw new Error("File key is outside this workspace.");
        await copyObject(source.FILES, target.FILES, key);
      }
    }
    if (tail.trim()) throw new Error("File listing was incomplete.");
  } finally { reader.releaseLock(); }
  // Publish the recovery checkpoint only after all referenced objects exist.
  if (objects.some(object => object.key === manifest)) await copyObject(source.DATA, target.DATA, manifest);
}
