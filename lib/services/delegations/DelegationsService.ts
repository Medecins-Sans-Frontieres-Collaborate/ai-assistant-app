/**
 * Per-process singleton serving the shared delegations document.
 *
 * Caching contract mirrors WorkflowPolicyService: `await ensureFresh()` (a
 * no-op while the 60 s TTL is warm), then read the snapshot synchronously.
 * Single-flight refresh, epoch guard so an `invalidate()` landing mid-refresh
 * is not lost, 5 s failure cooldown, last-known-good retention.
 *
 * Failure posture: with no snapshot at all there are NO delegations — nobody
 * is a delegated admin and nothing authored under a delegation is delivered.
 * That is fail-closed for every consumer of THIS service. (The limits policy
 * does not read through here: it composes delegations at its own store seam
 * and falls to its explicit `failMode`.)
 */
import { createDelegationsBlobStorage } from '@/lib/services/delegations/delegationsStore';
import {
  DelegationsDocument,
  SharedDelegation,
} from '@/lib/services/delegations/types';
import { loadDelegationsDocument } from '@/lib/services/limits/limitsStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const CACHE_TTL_MS = 60_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
const READ_DEADLINE_MS = 5_000;

export interface DelegationsSnapshot {
  document: DelegationsDocument | null;
  etag: string | null;
  /** No document has ever loaded on this replica (cold start + outage). */
  unavailable: boolean;
}

export class DelegationsService {
  private static instance: DelegationsService | null = null;

  private storage: BlobStorage | null = null;
  private document: DelegationsDocument | null = null;
  private etag: string | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): DelegationsService {
    if (!DelegationsService.instance) {
      DelegationsService.instance = new DelegationsService();
    }
    return DelegationsService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    DelegationsService.instance = null;
  }

  async ensureFresh(): Promise<void> {
    if (this.loadedOnce && Date.now() - this.fetchedAt < CACHE_TTL_MS) return;
    if (
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

  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastRefreshFailureAt = 0;
  }

  getSnapshot(): DelegationsSnapshot {
    return {
      document: this.document,
      etag: this.etag,
      unavailable: !this.loadedOnce,
    };
  }

  /** Enabled delegations only — the ones that can confer or deliver anything. */
  getEnabledDelegations(): SharedDelegation[] {
    return (this.document?.delegations ?? []).filter((d) => d.enabled);
  }

  private getStorage(): BlobStorage {
    if (!this.storage) this.storage = createDelegationsBlobStorage();
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await loadDelegationsDocument(this.getStorage(), {
        abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
      });
      if (epochAtEntry !== this.epoch) return;
      this.document = result.document;
      this.etag = result.etag;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastRefreshFailureAt = 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[delegations] refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'no delegations'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}
