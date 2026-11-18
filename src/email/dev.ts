import type { CapturedEmail } from "./index";
const captured: CapturedEmail[] = [];
/** Local-only inbox, never served by a production route. */
export function capturedEmails(): CapturedEmail[] {
  const since = Date.now() - 60 * 60 * 1000;
  while (captured.length && captured[0].createdAt < since) captured.shift();
  return captured.map((message) => ({ ...message }));
}

export function captureEmail(email: CapturedEmail) {
  captured.push(email);
  if (captured.length > 100) captured.shift();
}
