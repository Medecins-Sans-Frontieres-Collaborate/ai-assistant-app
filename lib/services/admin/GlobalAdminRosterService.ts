/**
 * Per-process singleton serving the config-based global admin roster.
 *
 * Caching contract is the same as LimitsService / AgentAccessService: callers
 * `await ensureFresh()` (a no-op while the 60s TTL is warm), then read the
 * synchronous snapshot — here through `isGlobalAdmin()`, which consults
 * lib/services/admin/globalAdminsSnapshot.ts, into which this service
 * publishes after every successful read. Single-flight refresh, epoch guard
 * so an `invalidate()` landing mid-refresh is not lost, last-known-good
 * retention. NEVER throws: the `auth()` session callback awaits
 * `ensureFresh()` on every request, so a throw here would break sign-in.
 *
 * ⚠ TWO DELIBERATE DEVIATIONS from LimitsService/AgentAccessService, both
 * because the warm-up sits inside the session callback (every `auth()` call,
 * every proxied request) and this service always has something safe to serve
 * (the env roster, or the last-known-good config roster):
 *
 * 1. `ensureFresh()` never waits on storage for longer than a bounded budget.
 *    - Warm-but-stale (`loadedOnce`, TTL lapsed): stale-while-revalidate — the
 *      refresh is kicked off (single-flight) and the caller returns at once
 *      with the last-known-good roster. Revocation latency stays ≈ TTL + one
 *      request; a stalled read costs callers nothing.
 *    - Cold (nothing loaded yet): the caller waits for the in-flight read OR
 *      `COLD_DEADLINE_MS`, whichever comes first. Past the deadline THAT
 *      request degrades to env-only (`rosterUnavailable`), while the read
 *      keeps running in the background; when it eventually resolves it
 *      publishes the snapshot, so later callers get the config roster.
 *    The read itself is bounded separately and far more loosely: the store
 *    aborts it after `ROSTER_READ_DEADLINE_MS` (15 s), at which point it is
 *    just a failed refresh (deviation 2 applies). Requests never wait on that
 *    deadline — it only stops a stalled connection from pending forever.
 * 2. The 5s failure cooldown applies EVEN ON COLD START. Those services retry
 *    eagerly before their first load because they have nothing to serve;
 *    here a storage outage that fails FAST would otherwise re-enter the full
 *    `withAzureRetry` cycle on every request. (A read that STALLS rather than
 *    fails is covered by deviation 1, not by the cooldown.)
 *
 * Cold + failed (or cold + stalled past the deadline) = env-only, which can
 * fail to recognise a config admin but can never grant — the safe direction.
 *
 * Per-process cache with no cross-replica invalidation: a roster change takes
 * up to 60s to reach every replica — the same revocation latency config.json
 * local admins have today. Deliberately NOT tied to the agent-access
 * generation sentinel: adminAreas.ts insists the admin models stay
 * independent, and AgentAccessService short-circuits when its feature flag is
 * off.
 */
import { publishGlobalAdminSnapshot } from '@/lib/services/admin/globalAdminsSnapshot';
import {
  createGlobalAdminsBlobStorage,
  readGlobalAdmins,
} from '@/lib/services/admin/globalAdminsStore';
import { GlobalAdminRoster } from '@/lib/services/admin/globalAdminsTypes';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const ROSTER_CACHE_TTL_MS = 60_000;
/** Applies after ANY failed refresh, including before the first load (see header). */
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
/**
 * Longest a COLD caller waits on the first roster read before degrading to
 * env-only for that request (see header, deviation 1). Warm callers never
 * wait. Exported for tests.
 */
export const COLD_DEADLINE_MS = 2_500;

export interface GlobalAdminRosterSnapshot {
  roster: GlobalAdminRoster | null;
  etag: string | null;
  /**
   * No roster has ever loaded (cold start + storage outage). Distinct from
   * `roster: null` with `rosterUnavailable: false`, which means "no roster has
   * been authored yet" — env admins only, by configuration rather than by
   * accident. adminAreas reports the former as `configUnavailable`.
   */
  rosterUnavailable: boolean;
  /** Epoch ms of the last successful refresh; null when never loaded. */
  fetchedAt: number | null;
}

export class GlobalAdminRosterService {
  private static instance: GlobalAdminRosterService | null = null;

  private storage: BlobStorage | null = null;
  private roster: GlobalAdminRoster | null = null;
  private etag: string | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  /** One stall warning per in-flight read, not one per parked request. */
  private stallLogged = false;

  static getInstance(): GlobalAdminRosterService {
    if (!GlobalAdminRosterService.instance) {
      GlobalAdminRosterService.instance = new GlobalAdminRosterService();
    }
    return GlobalAdminRosterService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    GlobalAdminRosterService.instance = null;
  }

  /**
   * Refreshes the cached roster when the TTL has expired (single-flight).
   * Never throws — a failure keeps the last-known-good roster (or, cold,
   * leaves the snapshot empty = env-only), visible only through
   * `rosterUnavailable` when nothing was ever loaded.
   *
   * Bounded wait (header, deviation 1): returns immediately when a roster is
   * already loaded (refresh continues in the background), and never blocks a
   * cold caller for longer than `COLD_DEADLINE_MS`.
   */
  async ensureFresh(): Promise<void> {
    if (this.loadedOnce && Date.now() - this.fetchedAt < ROSTER_CACHE_TTL_MS) {
      return;
    }
    if (
      this.lastRefreshFailureAt !== 0 &&
      Date.now() - this.lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      // Cooldown applies regardless of loadedOnce — see the header.
      return;
    }
    if (!this.refreshInFlight) {
      this.stallLogged = false;
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    if (this.loadedOnce) {
      // Stale-while-revalidate: serve last-known-good, refresh in background.
      return;
    }
    await this.awaitColdRefresh(this.refreshInFlight);
  }

  /**
   * Waits for the in-flight cold read or the cold deadline, whichever comes
   * first. The read itself is NOT cancelled here — letting it finish is what
   * lets later callers benefit; the store's own (much longer) read deadline
   * is what eventually fails a read that never settles.
   */
  private async awaitColdRefresh(inFlight: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineHit = false;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deadlineHit = true;
        resolve();
      }, COLD_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([inFlight, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (deadlineHit && !this.loadedOnce && !this.stallLogged) {
      this.stallLogged = true;
      console.warn(
        `[global-admins] cold roster read still pending after ${COLD_DEADLINE_MS}ms; serving env roster only until it settles`,
      );
    }
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

  getSnapshot(): GlobalAdminRosterSnapshot {
    return {
      roster: this.roster,
      etag: this.etag,
      rosterUnavailable: !this.loadedOnce,
      fetchedAt: this.loadedOnce ? this.fetchedAt : null,
    };
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      // Throws synchronously when no account is configured — so it is called
      // inside refresh()'s try, never in the constructor.
      this.storage = createGlobalAdminsBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readGlobalAdmins(this.getStorage());
      // A missing blob is a valid, fully-loaded state: no roster has been
      // authored yet, so only env admins are global admins.
      this.roster = result?.roster ?? null;
      this.etag = result?.etag ?? null;
      this.loadedOnce = true;
      this.lastRefreshFailureAt = 0;
      publishGlobalAdminSnapshot(this.roster?.admins ?? []);
      if (this.epoch === epochAtEntry) {
        this.fetchedAt = Date.now();
      }
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[global-admins] roster refresh FAILED (serving ${
          this.loadedOnce ? 'last-known-good' : 'env roster only'
        }): ${sanitizeForLog(error)}`,
      );
    }
  }
}
