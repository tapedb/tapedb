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
import type { AcrossLiveState, AcrossQuery } from "../model/across";
import type { PresencePeer, PresencePeersOptions } from "../client/types";
import type { BroadcastTopic, LiveState, Page, PageQuery, PresenceRoom, Query } from "../model/client";
import type { TopicGap, TopicSender } from "../client/types";

// Public, because `usePresence` takes it and `PresenceRoom.peers()` returns to
// it: a type a signature names must be nameable from the entry that names it.
export type { PresencePeersOptions } from "../client/types";

/**
 * Live results for a query: `useLive(db.task.findMany({ where }))`.
 *
 * A new query object every render is fine: the subscription follows the
 * query's key, not its identity, so equal arguments keep one subscription.
 */
export function useLive<T>(query: AcrossQuery<T>): AcrossLiveState<T>;
export function useLive<T>(query: Query<T>): LiveState<T>;
export function useLive<T>(query: Query<T> | AcrossQuery<T>): LiveState<T> {
  const queryRef = useRef(query);
  queryRef.current = query;

  const subscribe = useMemo(
    () => (onChange: () => void) => (queryRef.current as Query<T>).subscribe(onChange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.key]
  );
  const snapshot = () => (queryRef.current as Query<T>).snapshot();
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
 *
 * Your own entry is included and marked `isSelf: true`; pass
 * `{ includeSelf: false }` to leave it out.
 */
export function usePresence(
  db: { $presence(room: string): PresenceRoom },
  room: string,
  presence?: unknown,
  options?: PresencePeersOptions
): PresencePeer[] {
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const handle = useMemo(() => db.$presence(room), [db, room]);
  const serialised = presence === undefined ? undefined : stableStringify(presence);
  const includeSelf = options?.includeSelf === true;

  useEffect(() => handle.subscribe(setPeers, { includeSelf }), [handle, includeSelf]);
  useEffect(() => {
    if (presence !== undefined) handle.set(presence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, serialised]);
  useEffect(() => () => handle.leave(), [handle]);

  return peers;
}


/**
 * Listens on a broadcast topic while mounted and returns its `send`. The
 * latest `onMessage` and `onGap` are always the ones called, so neither need
 * be memoised. `onGap` hears messages the replay window dropped.
 *
 * @experimental May change in a minor release.
 */
export function useBroadcast<T = unknown>(
  db: { $broadcast<M>(topic: string): BroadcastTopic<M> },
  topic: string,
  onMessage?: (message: T, from: TopicSender) => void,
  onGap?: (gap: TopicGap) => void
): (message: T) => boolean | "queued" {
  const handle = useMemo(() => db.$broadcast<T>(topic), [db, topic]);
  const listener = useRef(onMessage);
  listener.current = onMessage;
  const gapListener = useRef(onGap);
  gapListener.current = onGap;

  useEffect(
    () =>
      handle.subscribe(
        (message, from) => listener.current?.(message, from),
        { onGap: (gap) => gapListener.current?.(gap) }
      ),
    [handle]
  );
  return useCallback((message: T) => handle.send(message), [handle]);
}

/** Props supplied to the default export of tapedb.auth.tsx. */
export interface AuthPageProps { redirectTo: string }
