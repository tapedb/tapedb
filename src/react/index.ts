"use client";

/**
 * React bindings: `useLive`, `useLivePage`, `usePresence`.
 *
 * The only entry in the package that imports React. Hooks take the queries
 * and rooms a `createClient()` client returns, so hooks and plain calls share
 * one socket, one cache and one outbox.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { stableStringify } from "../client/stable";
import type { PresencePeer } from "../client/types";
import type { BroadcastTopic, LiveState, Page, PageQuery, PresenceRoom, Query } from "../model/client";
import type { TopicSender } from "../client/types";

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


/**
 * Listens on a broadcast topic while mounted and returns its `send`. The
 * latest `onMessage` is always the one called, so it need not be memoised.
 */
export function useBroadcast<T = unknown>(
  db: { $broadcast<M>(topic: string): BroadcastTopic<M> },
  topic: string,
  onMessage?: (message: T, from: TopicSender) => void
): (message: T) => boolean {
  const handle = useMemo(() => db.$broadcast<T>(topic), [db, topic]);
  const listener = useRef(onMessage);
  listener.current = onMessage;

  useEffect(
    () => handle.subscribe((message, from) => listener.current?.(message, from)),
    [handle]
  );
  return useCallback((message: T) => handle.send(message), [handle]);
}
