export { createOutbox, IndexedDbOutbox, scopedOutboxName } from "../../src/client/outbox";
import { createHeadlessClient } from "../../src/client/data-client";

export function client(workspaceId: string) {
  return createHeadlessClient({
    workspaceId, apiUrl: location.origin, userId: "browser-user",
    getToken: async () => `e30.${btoa(JSON.stringify({ sub: "browser-user" }))}.test`,
  }, {
    createWebSocket: () => ({
      onopen: null, onclose: null, onmessage: null, onerror: null,
      send() {}, close() {},
    }),
  });
}
