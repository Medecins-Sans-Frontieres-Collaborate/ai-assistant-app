/**
 * Per-replica, byte-bounded, least-recently-used cache for admin-entity
 * PAYLOADS that live outside the access snapshot (guide payload blobs, map
 * dataset data blobs).
 *
 * Why it exists: the AgentAccessService snapshot re-downloads every listed
 * record on every refresh, on every replica, whether anyone uses it. Large
 * payloads therefore stay OUT of the snapshot and are loaded on demand here,
 * so replica memory is bounded by the working set (this budget) rather than
 * by the catalogue.
 *
 * Two entry kinds:
 * - IMMUTABLE keys (guide payload refs — a new save mints a new blob name):
 *   cached until evicted, never revalidated.
 * - REVALIDATED keys (dataset data blobs — mutable, ETag-anchored): the
 *   loader receives the cached ETag and may answer "unchanged".
 *
 * Single-flight per key: concurrent misses share one load. Loader failures
 * are never cached.
 */

export interface CacheEntry<T> {
  value: T;
  /** Approximate resident size (decoded bytes); drives the byte budget. */
  bytes: number;
  /** Raw Azure ETag for revalidated entries; undefined for immutable ones. */
  etag?: string;
}

export type CacheLoader<T> = (
  cached: CacheEntry<T> | null,
) => Promise<CacheEntry<T> | 'unchanged' | null>;

/** 32 MB of decoded payload per replica — a few dozen large guides/datasets. */
export const DEFAULT_PAYLOAD_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * A single value larger than this share of the budget is served but never
 * retained — one giant payload must not evict everything else.
 */
const MAX_SINGLE_ENTRY_SHARE = 0.5;

export class PayloadCache {
  /** Insertion order = recency (Map preserves order; re-set moves to end). */
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<
    string,
    Promise<CacheEntry<unknown> | null>
  >();
  private totalBytes = 0;

  constructor(
    private readonly budgetBytes: number = DEFAULT_PAYLOAD_CACHE_BUDGET_BYTES,
  ) {}

  /**
   * Returns the cached value (marking it recently used) or runs `loader`.
   * A loader answering 'unchanged' keeps the cached entry; null means the
   * blob is gone (the cached entry, if any, is dropped and null returned).
   */
  async getOrLoad<T>(
    key: string,
    loader: CacheLoader<T>,
  ): Promise<CacheEntry<T> | null> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<CacheEntry<T> | null>;

    const promise = this.load(key, loader).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise as Promise<CacheEntry<unknown> | null>);
    return promise;
  }

  /** Immutable fast path: a hit never calls the loader. */
  async getOrLoadImmutable<T>(
    key: string,
    loader: () => Promise<CacheEntry<T> | null>,
  ): Promise<CacheEntry<T> | null> {
    const hit = this.touch<T>(key);
    if (hit) return hit;
    return this.getOrLoad<T>(key, () => loader());
  }

  peek<T>(key: string): CacheEntry<T> | null {
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Drops every key under a prefix (e.g. all payload versions of one id). */
  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private touch<T>(key: string): CacheEntry<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Re-insert to move to the most-recent end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry as CacheEntry<T>;
  }

  private async load<T>(
    key: string,
    loader: CacheLoader<T>,
  ): Promise<CacheEntry<T> | null> {
    const cached = this.touch<T>(key);
    const result = await loader(cached);
    if (result === 'unchanged') {
      if (cached) return cached;
      // A loader may only answer 'unchanged' against a cached entry; treat
      // the contradiction as a miss rather than inventing a value.
      throw new Error(`payload cache: 'unchanged' for uncached key ${key}`);
    }
    if (result === null) {
      this.delete(key);
      return null;
    }
    this.store(key, result);
    return result;
  }

  private store<T>(key: string, entry: CacheEntry<T>): void {
    this.delete(key);
    if (entry.bytes > this.budgetBytes * MAX_SINGLE_ENTRY_SHARE) {
      // Served, not retained.
      return;
    }
    this.entries.set(key, entry as CacheEntry<unknown>);
    this.totalBytes += entry.bytes;
    while (this.totalBytes > this.budgetBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined || oldestKey === key) break;
      this.delete(oldestKey);
    }
  }
}

/** The process-wide cache shared by every admin payload reader. */
let sharedCache: PayloadCache | null = null;

export function getPayloadCache(): PayloadCache {
  if (!sharedCache) sharedCache = new PayloadCache();
  return sharedCache;
}

/** Test seam: replace (or reset) the shared instance. */
export function setPayloadCacheForTests(cache: PayloadCache | null): void {
  sharedCache = cache;
}
