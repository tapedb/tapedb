export { createOutbox, IndexedDbOutbox } from "../../src/client/outbox";
import { createHeadlessClient } from "../../src/client/data-client";

export function client(workspaceId: string) {
  return createHeadlessClient({
    workspaceId, apiUrl: location.origin, getToken: async () => "browser-test-token",
  }, {
    createWebSocket: () => ({
      onopen: null, onclose: null, onmessage: null, onerror: null,
      send() {}, close() {},
    }),
  });
}
