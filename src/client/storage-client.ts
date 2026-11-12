/** Authenticated file transport for the existing app-scoped R2 routes. */
export const MAX_STORAGE_UPLOAD_BYTES = 25 * 1024 * 1024;

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
  const fetcher = config.fetch ?? globalThis.fetch;

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
    signal?: AbortSignal
  ) {
    const target = url(path);
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
        ...(body
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
      if (file.size > MAX_STORAGE_UPLOAD_BYTES)
        throw new StorageError(413, "upload_too_large");
      return (
        await request(path, "PUT", file, signal)
      ).json() as Promise<StorageObject>;
    },
    async download(path, signal) {
      return (await request(path, "GET", undefined, signal)).blob();
    },
    async delete(path, signal) {
      await request(path, "DELETE", undefined, signal);
    },
  };
}
