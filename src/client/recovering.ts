/**
 * A workspace being restored from R2 answers 503 `workspace_recovering` with
 * `Retry-After` until its data is complete. Requests wait it out and retry,
 * so a read or a write made during a restore gets its answer when the data is
 * there instead of an error. Live queries need nothing here: the socket
 * reconnects on its own schedule.
 */

/** How long one request waits for a restore before the 503 surfaces. */
export const RECOVERING_WAIT_MS = 60_000;
/** Longest pause between attempts, whatever `Retry-After` says. */
const MAX_PAUSE_MS = 5_000;

interface RetryableResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface RecoveringRetryOptions {
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pauseFor(response: RetryableResponse): number {
  const header = response.headers?.get("retry-after");
  const seconds = header === null || header === undefined ? NaN : Number(header);
  return Math.min(MAX_PAUSE_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000);
}

/**
 * Wraps a fetch so a 503 `workspace_recovering` is retried until the restore
 * is done or `waitMs` passes. A request whose body is a stream is sent once:
 * it cannot be sent again.
 */
export function retryWhileRecovering<Init extends { body?: unknown }, Response extends RetryableResponse>(
  fetchImpl: (url: string, init: Init) => Promise<Response>,
  options: RecoveringRetryOptions = {}
): (url: string, init: Init) => Promise<Response> {
  const waitMs = options.waitMs ?? RECOVERING_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  return async (url, init) => {
    const started = now();
    for (;;) {
      const response = await fetchImpl(url, init);
      if (response.status !== 503 || (typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream)) {
        return response;
      }
      // The body is read once here, so the caller gets it from this copy.
      const payload = await response.json().catch(() => null);
      const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
      const answered = {
        ok: response.ok,
        status: response.status,
        statusText: (response as { statusText?: string }).statusText ?? "",
        headers: response.headers,
        body: null,
        json: async () => payload,
        text: async () => (payload === null ? "" : JSON.stringify(payload)),
      } as unknown as Response;
      if (code !== "workspace_recovering") return answered;
      const pause = pauseFor(response);
      if (now() - started + pause > waitMs) return answered;
      await sleep(pause);
    }
  };
}
