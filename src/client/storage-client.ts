/**
 * Authenticated file transport for the workspace's R2 routes. A file of any
 * size uploads: up to `UPLOAD_PART_BYTES` in one request, larger as a
 * multipart upload of parts that size (R2 objects reach 5 TB).
 */
import { retryWhileRecovering, type RecoveringRetryOptions } from "./recovering";

export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

export interface StorageObject {
  id: string;
  key: string;
  size: number;
  etag: string;
  contentType: string;
}

export interface StorageClient {
  upload(
    path: string,
    file: Blob,
    signal?: AbortSignal
  ): Promise<StorageObject>;
  download(path: string, signal?: AbortSignal): Promise<Blob>;
  delete(path: string, signal?: AbortSignal): Promise<void>;
}

export type StorageFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface StorageClientConfig {
  apiUrl: string;
  /** Explicit registered app id, bound server-side to the claim's workspace. */
  appId?: string;
  /** Workspace-native transport; mutually exclusive with appId. */
  workspaceId?: string;
  getToken: () => Promise<string>;
  fetch?: StorageFetch;
  /** Test hook: how requests wait out a restore. */
  recoveringRetry?: RecoveringRetryOptions;
}

export class StorageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(`Storage request failed (${status}, ${code}).`);
    this.name = "StorageError";
  }
}

export function createStorageClient(
  config: StorageClientConfig
): StorageClient {
  const scope = config.workspaceId ?? config.appId;
  if (
    !scope ||
    Boolean(config.workspaceId) === Boolean(config.appId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(scope)
  )
    throw new Error("Storage requires a valid registered app id.");
  const base = new URL(config.apiUrl);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "Storage requires an HTTP(S) API URL without credentials, query or fragment."
    );
  // A workspace being restored answers 503 until its file index is back.
  const fetcher = retryWhileRecovering(
    (input: string, init: RequestInit) => (config.fetch ?? globalThis.fetch)(input, init),
    config.recoveringRetry
  );

  const url = (path: string) => {
    if (
      !/^[A-Za-z0-9!_.*'()/-]{1,512}$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid storage object path.");
    return `${base.href.replace(/\/+$/, "")}/${config.workspaceId ? `engine/workspaces/${scope}/files` : `storage/${scope}`}/${path.split("/").map(encodeURIComponent).join("/")}`;
  };

  async function request(
    path: string,
    method: string,
    body?: Blob,
    signal?: AbortSignal,
    query = "",
    contentType?: string
  ) {
    const target = `${url(path)}${query}`;
    const token = await config.getToken();
    if (!token) throw new Error("Storage requires a workspace claim.");
    const response = await fetcher(target, {
      method,
      body,
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        ...(contentType !== undefined
          ? { "content-type": contentType }
          : body
            ? { "content-type": body.type || "application/octet-stream" }
            : {}),
      },
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      throw new StorageError(
        response.status,
        typeof error?.error?.code === "string"
          ? error.error.code
          : "storage_request_failed"
      );
    }
    return response;
  }

  return {
    async upload(path, file, signal) {
      if (file.size <= UPLOAD_PART_BYTES) {
        return (await request(path, "PUT", file, signal)).json() as Promise<StorageObject>;
      }
      const type = file.type || "application/octet-stream";
      const { uploadId } = (await (await request(path, "POST", undefined, signal, "?uploads", type)).json()) as {
        uploadId: string;
      };
      const id = encodeURIComponent(uploadId);
      try {
        const parts: Array<{ partNumber: number; etag: string }> = [];
        for (let offset = 0, partNumber = 1; offset < file.size; offset += UPLOAD_PART_BYTES, partNumber += 1) {
          const chunk = file.slice(offset, Math.min(offset + UPLOAD_PART_BYTES, file.size));
          const response = await request(path, "PUT", chunk, signal, `?uploadId=${id}&partNumber=${partNumber}`, "application/octet-stream");
          parts.push((await response.json()) as { partNumber: number; etag: string });
        }
        const done = new Blob([JSON.stringify({ parts })], { type: "application/json" });
        return (await request(path, "POST", done, signal, `?uploadId=${id}`)).json() as Promise<StorageObject>;
      } catch (error) {
        await request(path, "DELETE", undefined, undefined, `?uploadId=${id}`).catch(() => undefined);
        throw error;
      }
    },
    async download(path, signal) {
      return (await request(path, "GET", undefined, signal)).blob();
    },
    async delete(path, signal) {
      await request(path, "DELETE", undefined, signal);
    },
  };
}
