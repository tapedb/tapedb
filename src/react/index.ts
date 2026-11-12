"use client";

/**
 * React bindings. The only entry point in the package that imports React.
 *
 * `init()` returns a client with `useQuery`, `transact`, `storage` and
 * presence; `createDataClient` and `createTxProxy` are exposed for advanced
 * use and for tests.
 */

export {
  createDataClient,
  createTxProxy,
  deriveWebSocketUrl,
  init,
  ServerError,
} from "./client";
export type { ClientDeps, FetchLike, FetchResponseLike } from "./client";

export * from "../client";
