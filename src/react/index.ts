"use client";

/**
 * React bindings.
 *
 * This is the only entry point in the package that imports React. The client
 * itself lives in `tapedb` and works without React; this layer adds `useQuery`
 * on top of the same instance, so hooks and headless calls share one socket,
 * one cache and one outbox.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  createClientParts,
  type ClientDeps,
} from "../client/data-client";
import { stableStringify } from "../client/stable";
import type {
  DataClient,
  InitConfig,
  PresencePeer,
  QueryDocument,
  QueryState,
} from "../client/types";
import type { LiveState, Page, PageQuery, PresenceRoom, Query } from "../model/client";

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

/**
 * Live results for a query: `useLive(db.task.findMany({ where }))`.
 *
 * A new query object every render is fine: the subscription follows the
 * query's key, not its identity, so equal arguments keep one subscription.
 */
export function useLive<T>(query: Query<T>): LiveState<T> {
  const queryRef = useRef(query);
  queryRef.current = query;

  const subscribe = useMemo(
    () => (onChange: () => void) => queryRef.current.subscribe(onChange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.key]
  );
  const snapshot = () => queryRef.current.snapshot();
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export interface LivePage<R> {
  rows: R[];
  hasMore: boolean;
  isLoading: boolean;
  error: LiveState<Page<R>>["error"];
  /** Appends the next page; every loaded page stays live. */
  loadMore(): Promise<boolean>;
}

/** Live pages: `useLivePage(db.task.findPage({ orderBy, take: 50 }))`. */
export function useLivePage<R>(query: PageQuery<R>): LivePage<R> {
  const state = useLive(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const loadMore = useCallback(() => queryRef.current.loadMore(), []);
  return {
    rows: state.data?.rows ?? [],
    hasMore: state.data?.hasMore ?? false,
    isLoading: state.isLoading,
    error: state.error,
    loadMore,
  };
}

/**
 * Joins a presence room with `presence` and returns the other peers. Leaves
 * the room on unmount; publishes again whenever `presence` changes.
 */
export function usePresence(
  db: { $presence(room: string): PresenceRoom },
  room: string,
  presence?: unknown
): PresencePeer[] {
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const handle = useMemo(() => db.$presence(room), [db, room]);
  const serialised = presence === undefined ? undefined : stableStringify(presence);

  useEffect(() => handle.subscribe(setPeers), [handle]);
  useEffect(() => {
    if (presence !== undefined) handle.set(presence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, serialised]);
  useEffect(() => () => handle.leave(), [handle]);

  return peers;
}

/** Creates a workspace client with React hooks, room and storage adapters. */
export function init(config: InitConfig): DataClient {
  return createDataClient(config);
}

export * from "../client/data-client";
export * from "../client";
