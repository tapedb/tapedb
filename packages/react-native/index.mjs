// `@tapedb/react-native` is the one thing React Native needs that a browser
// gets for free: a durable queue for writes made while offline, and a client
// factory that wires it. React Native is a runtime, not a view layer, so this
// package depends on neither `react` nor `react-native`: the store is an
// interface the core defines and the app's own AsyncStorage satisfies it. Use
// `@tapedb/react` for the hooks — it is the same module on web and on device.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AsyncStorageOutbox, createClient, scopedOutboxName } from "@tapedb/tapedb";

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
