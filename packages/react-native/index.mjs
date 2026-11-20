// `@tapedb/react-native` is `@tapedb/tapedb/react` — same hooks, same module,
// same release — plus the one thing React Native needs that a browser gets for
// free: a durable queue for writes made while offline. The view layer is thin
// and this file has to run under Node too (its smoke test imports it there),
// so nothing here imports `react-native`: the store is a peer module and an
// interface the core defines, and the app's own AsyncStorage satisfies it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AsyncStorageOutbox, createClient, scopedOutboxName } from "@tapedb/tapedb";

export * from "@tapedb/tapedb/react";
export { AsyncStorageOutbox } from "@tapedb/tapedb";

/**
 * `createClient()` for React Native: the same options, with an
 * `AsyncStorage`-backed outbox instead of the IndexedDB one no RN runtime has.
 *
 * The queue is scoped the way the browser scopes its own — `url` plus
 * `userId` — so an account's pending writes are never replayed with the next
 * account's claim.
 *
 * @param config `createClient`'s options. `storage` overrides the store (a
 *   test passes a Map-like fake); `outbox` overrides the queue outright.
 */
export function createReactNativeClient({ storage = AsyncStorage, outbox, ...config }) {
  return createClient({
    ...config,
    outbox:
      outbox ??
      new AsyncStorageOutbox(storage, {
        prefix: `${scopedOutboxName(config.url, config.userId)}:`,
      }),
  });
}
