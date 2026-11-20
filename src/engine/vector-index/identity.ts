/**
 * Vector IDs and namespaces: how one row becomes one addressable vector.
 *
 * Both are derived, never supplied. A client cannot name an index, a namespace
 * or a vector ID, so one workspace cannot address another's vectors even if it
 * knows the row IDs (two workspaces in one index do share row IDs).
 *
 * - **Namespace**: `base64url(SHA-256(deployment, workspace))` — 43 ASCII
 *   characters, inside the provider's 64-byte namespace cap with room to spare,
 *   and stable for the life of the workspace so a rebuild does not strand the
 *   vectors written before it.
 * - **Vector ID**: `hex(SHA-256(deployment, workspace, model, field, row))` —
 *   exactly 64 characters, the provider's ID cap. A row ID is an app-supplied
 *   string of unknown length, so it is hashed rather than embedded, and the
 *   deployment and workspace are in the preimage so the same row in two
 *   workspaces cannot collide even if one were indexed without a namespace.
 *
 * Both are opaque by design: provider metadata and IDs carry no note text, no
 * raw workspace ID and no identity.
 */

import { hex, sha256Hex } from "./digest";

/** The provider's ceiling for a vector ID, in bytes. */
export const VECTOR_ID_MAX_BYTES = 64;
/** The provider's ceiling for a namespace name, in bytes. */
export const VECTOR_NAMESPACE_MAX_BYTES = 64;

const SEP = "\u001f";

/** The workspace's namespace within `binding`'s index. 43 characters. */
export async function vectorNamespaceFor(binding: string, workspaceId: string): Promise<string> {
  const digest = await sha256Hex(`tapedb.vector.namespace/1${SEP}${binding}${SEP}${workspaceId}`);
  return base64url(hexToBytes(digest));
}

/** One row's vector ID. 64 characters. */
export async function vectorIdFor(input: {
  binding: string;
  workspaceId: string;
  model: string;
  field: string;
  rowId: string;
}): Promise<string> {
  const id = await sha256Hex(
    [
      "tapedb.vector.id/1",
      input.binding,
      input.workspaceId,
      input.model,
      input.field,
      input.rowId,
    ].join(SEP)
  );
  // SHA-256 hex is exactly 64 characters, every one ASCII.
  return id.slice(0, VECTOR_ID_MAX_BYTES);
}

/** Unpadded base64url of 32 bytes: 43 characters. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hexToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
