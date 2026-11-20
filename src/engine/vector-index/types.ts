/**
 * The index side of a vector field: one narrow interface, the Cloudflare
 * binding behind it, and an in-memory implementation for tests.
 *
 * The platform's own type (`VectorizeIndex`) is wide: inserts, queries by ID,
 * listing, metadata indexes, a `mutationId` on every asynchronous mutation. A
 * workspace needs four operations, so `VectorIndex` is those four and nothing
 * else — a test double can implement it in a page, and swapping the provider
 * later is a file rather than a search.
 *
 * Every mutation is asynchronous at the provider: `upsert` and `deleteByIds`
 * answer with a mutation ID the moment the request is accepted, and the
 * vectors become visible to queries seconds to minutes later. That is why the
 * queue below treats "accepted" and "visible" as different states, records the
 * mutation ID, and never waits for the index to answer a commit.
 */

/** One vector, as the provider takes it. */
export interface VectorRecord {
  /** At most 64 bytes; derived from the row, never supplied by a client. */
  id: string;
  /** Exactly the declared dimension count, float32-representable. */
  values: number[];
  /**
   * The workspace's namespace within the index. One deployment shares one
   * index across every workspace, so this is the isolation boundary.
   */
  namespace?: string;
  /** Equality-filterable values plus the row's version digest. */
  metadata?: Record<string, string | number | boolean>;
}

/** What the provider returns when it has accepted a batch. */
export interface VectorIndexMutation {
  /**
   * Correlates a submission with a later reconciliation. Not a watermark: the
   * provider does not promise these are ordered, and they are not.
   */
  mutationId: string;
}

/** Query options, as the platform documents them. */
export interface VectorQueryOptions {
  /** 1–50 when values or metadata come back with the matches, 100 without. */
  topK?: number;
  namespace?: string;
  /** Equality conditions, applied before the ranking. */
  filter?: Record<string, string | number | boolean>;
  returnValues?: boolean;
  returnMetadata?: "none" | "indexed" | "all";
}

/** One candidate the provider ranked. */
export interface VectorMatch {
  id: string;
  /** Cosine similarity: higher is closer. */
  score: number;
  values?: number[];
  namespace?: string;
  metadata?: Record<string, string | number | boolean>;
}

/** A ranked page. Fewer matches than `topK` is a valid answer. */
export interface VectorQueryResult {
  matches: VectorMatch[];
  count: number;
}

/** What an index says about itself. */
export interface VectorIndexDescription {
  /** The binding's name, when the deployment knows it. */
  name?: string;
  /** Declared dimensions; compared with the schema before anything is sent. */
  dimensions?: number;
  metric?: string;
}

/**
 * The four operations a workspace needs from a vector index.
 *
 * A provider error must reject: the drain reads a rejection as "nothing was
 * accepted" and retries, so an implementation that swallows one would lose
 * work silently.
 */
export interface VectorIndex {
  /** Upserts up to the platform's batch ceiling; resolves once accepted. */
  upsert(vectors: readonly VectorRecord[]): Promise<VectorIndexMutation>;
  /** Deletes by ID. Deleting an absent ID is not an error at the provider. */
  deleteByIds(ids: readonly string[]): Promise<VectorIndexMutation>;
  query(vector: readonly number[], options?: VectorQueryOptions): Promise<VectorQueryResult>;
  describe(): Promise<VectorIndexDescription>;
}
