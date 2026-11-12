"use client";

/**
 * React bindings.
 *
 * This is the only entry point in the package that imports React. The client
 * itself lives in `tapedb` and works without React; this layer adds `useQuery`
 * on top of the same instance, so hooks and headless calls share one socket,
 * one cache and one outbox.
 */

import { useRef, useSyncExternalStore } from "react";

import {
  createClientParts,
  type ClientDeps,
} from "../client/data-client";
import { stableStringify } from "../client/stable";
import type {
  DataClient,
  InitConfig,
  QueryDocument,
  QueryState,
} from "../client/types";

export function createDataClient(
  config: InitConfig,
  deps: ClientDeps = {}
): DataClient {
  const { client, impl } = createClientParts(config, deps);

  /**
   * Named `useQuery` so React's rules-of-hooks lint recognises the hook calls.
   * Keeping it outside the class avoids treating the client as a class
   * component.
   */
  function useQuery(query: QueryDocument): QueryState {
    const key = stableStringify(query);
    const queryRef = useRef(query);
    queryRef.current = query;

    const subscriptionRef = useRef<{
      key: string;
      subscribe: (onStoreChange: () => void) => () => void;
    } | null>(null);

    let subscription = subscriptionRef.current;
    if (subscription === null || subscription.key !== key) {
      subscription = {
        key,
        subscribe: (onStoreChange) =>
          impl.subscribeQuery(queryRef.current, onStoreChange),
      };
      subscriptionRef.current = subscription;
    }

    const getSnapshot = () => impl.getQueryState(queryRef.current);

    return useSyncExternalStore(
      subscription.subscribe,
      getSnapshot,
      getSnapshot
    );
  }

  return { ...client, useQuery };
}

/** Creates a workspace client with React hooks, room and storage adapters. */
export function init(config: InitConfig): DataClient {
  return createDataClient(config);
}

export * from "../client/data-client";
export * from "../client";
