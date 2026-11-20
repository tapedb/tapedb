// Types for `@tapedb/react-native`: the AsyncStorage queue and the client
// factory that wires it. The hooks are `@tapedb/react`'s, unchanged.
import type {
  AsyncStorageLike,
  Client,
  ClientConfig,
  Models,
  Outbox,
} from "@tapedb/tapedb";

export { AsyncStorageOutbox } from "@tapedb/tapedb";

/**
 * `createClient`'s options, plus where the offline queue lives.
 *
 * `outbox` is inherited and still wins: pass one to take over the queue
 * entirely (a SQLite store, a shared queue for several clients).
 */
export interface ReactNativeClientConfig<M extends Models>
  extends ClientConfig<M> {
  /**
   * The key-value store behind the queue. Defaults to
   * `@react-native-async-storage/async-storage`; passed explicitly, any store
   * with `getItem`, `setItem`, `removeItem`, `getAllKeys` and `multiRemove`
   * will do.
   */
  storage?: AsyncStorageLike;
}

/**
 * A client whose pending writes are durable across a restart: a write made
 * while offline is listed back and replayed when the app is launched again.
 */
export declare function createReactNativeClient<M extends Models>(
  config: ReactNativeClientConfig<M> & { outbox?: Outbox }
): Client<M>;
