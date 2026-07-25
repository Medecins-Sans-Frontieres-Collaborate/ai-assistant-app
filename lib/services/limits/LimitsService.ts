/**
 * Per-process singleton serving the usage-limits policy.
 *
 * Caching contract is the same as AgentAccessService: callers `await
 * ensureFresh()` (a no-op while the 60s TTL is warm), then call synchronous
 * resolvers any number of times over that snapshot. Single-flight refresh,
 * epoch guard so an `invalidate()` landing mid-refresh is not lost, 5s
 * failure cooldown, last-known-good retention.
 *
 * ⚠ ONE DELIBERATE INVERSION vs AgentAccessService. Agent access fails CLOSED
 * on cold start with no snapshot, because it is a security control. A quota
 * is a COST control, so limits fall back to the compiled catalog defaults
 * (i.e. unlimited) and set `policyUnavailable`. Failing closed here would
 * turn a blob outage into a total chat outage for the entire organisation.
 * The `failMode` policy field exists for an operator who disagrees, but it
 * cannot apply before any policy has ever been read — there is nothing to
 * read it from.
 *
 * As everywhere else in this app, the cache is per-process with no
 * cross-replica invalidation: a lowered limit takes up to 60s to reach every
 * replica. Counters are deliberately NEVER cached — that is what makes the
 * reservation guarantee real.
 */
import {
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import { LimitsPolicy } from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

const POLICY_CACHE_TTL_MS = 60_000;
/**
 * After a failed refresh, replicas holding a last-known-good policy serve it
 * without touching storage for this long, so an outage does not make every
 * request pay full storage-retry latency.
 */
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;

export interface LimitsSnapshot {
  policy: LimitsPolicy | null;
  etag: string | null;
  /**
   * Enabled, but no policy has ever loaded (cold start + storage outage).
   * Distinct from `policy: null` with `policyUnavailable: false`, which means
   * "no policy has been authored yet" — an admin UI that renders those two
   * identically would tell an admin everything is unlimited during an outage.
   */
  policyUnavailable: boolean;
  /** Epoch ms of the last successful refresh; null when never loaded. */
  fetchedAt: number | null;
}

export class LimitsService {
  private static instance: LimitsService | null = null;

  private storage: BlobStorage | null = null;
  private policy: LimitsPolicy | null = null;
  private etag: string | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): LimitsService {
    if (!LimitsService.instance) {
      LimitsService.instance = new LimitsService();
    }
    return LimitsService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    LimitsService.instance = null;
  }

  isEnabled(): boolean {
    return env.LIMITS_ENABLED;
  }

  /**
   * Refreshes the cached policy when the TTL has expired (single-flight).
   * Never throws — a failure keeps the last-known-good policy, and is only
   * visible through `policyUnavailable` when nothing was ever loaded.
   */
  async ensureFresh(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.loadedOnce && Date.now() - this.fetchedAt < POLICY_CACHE_TTL_MS) {
      return;
    }
    if (
      this.loadedOnce &&
      this.lastRefreshFailureAt !== 0 &&
      Date.now() - this.lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  /**
   * Forces the next ensureFresh() to refetch (called after an admin write on
   * the replica that served it). Bumping the epoch makes any in-flight
   * refresh complete WITHOUT stamping freshness, since it may carry pre-write
   * data.
   */
  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastRefreshFailureAt = 0;
  }

  getSnapshot(): LimitsSnapshot {
    return {
      policy: this.policy,
      etag: this.etag,
      policyUnavailable: this.isEnabled() && !this.loadedOnce,
      fetchedAt: this.loadedOnce ? this.fetchedAt : null,
    };
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      this.storage = createLimitsBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readPolicy(this.getStorage());
      // A missing blob is a valid, fully-loaded state: no policy has been
      // authored yet, so everything resolves from the compiled catalog.
      this.policy = result?.policy ?? null;
      this.etag = result?.etag ?? null;
      this.loadedOnce = true;
      this.lastRefreshFailureAt = 0;
      if (this.epoch === epochAtEntry) {
        this.fetchedAt = Date.now();
      }
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[limits] policy refresh FAILED (serving ${
          this.loadedOnce ? 'last-known-good' : 'compiled defaults — FAIL-OPEN'
        }): ${sanitizeForLog(error)}`,
      );
    }
  }
}
