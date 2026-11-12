export function json(
  data: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string
): Response {
  return json({ error: { code, message } }, status);
}

/** True when the deployment opted into the deep `/smoke` probe. */
export function smokeEnabled(env: { ENABLE_SMOKE?: string }): boolean {
  return env.ENABLE_SMOKE === "true";
}

/**
 * Discards an unread request body before responding. Workers tear down a
 * connection whose body was never consumed once the response is sent.
 */
export async function discardBody(request: Request): Promise<void> {
  if (request.body && !request.bodyUsed) {
    await request.body.cancel().catch(() => undefined);
  }
}
