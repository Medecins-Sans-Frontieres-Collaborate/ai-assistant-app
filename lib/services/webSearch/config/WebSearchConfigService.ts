/**
 * Per-process singleton serving the web search configuration.
 *
 * Caching contract mirrors WorkflowPolicyService: `await ensureFresh()`
 * (no-op while the 60s TTL is warm), then read `getMultiStep()`
 * synchronously. Single-flight refresh, epoch guard so an `invalidate()`
 * landing mid-refresh is not lost, 5s failure cooldown, last-known-good
 * retention.
 *
 * Failure posture: there is none to choose. With no snapshot at all — cold
 * start during a storage outage, or nothing authored yet — `getMultiStep()`
 * answers from the code defaults in types.ts. Search must never wait on, or
 * fail because of, this document.
 */
import { isAllowedAssessorModel } from '@/lib/services/webSearch/config/assessorModels';
import {
  ResolvedMultiStepConfig,
  WebSearchConfig,
  resolveMultiStepConfig,
} from '@/lib/services/webSearch/config/types';
import {
  createWebSearchConfigBlobStorage,
  readWebSearchConfig,
} from '@/lib/services/webSearch/config/webSearchConfigStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const CONFIG_CACHE_TTL_MS = 60_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
// A cold replica must not hold a user's search hostage to a slow blob read:
// past this, the turn proceeds on the defaults and the refresh finishes in
// the background for the next request.
const COLD_READ_BUDGET_MS = 2_500;

export class WebSearchConfigService {
  private static instance: WebSearchConfigService | null = null;

  private storage: BlobStorage | null = null;
  private config: WebSearchConfig | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): WebSearchConfigService {
    if (!WebSearchConfigService.instance) {
      WebSearchConfigService.instance = new WebSearchConfigService();
    }
    return WebSearchConfigService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    WebSearchConfigService.instance = null;
  }

  async ensureFresh(): Promise<void> {
    if (this.loadedOnce && Date.now() - this.fetchedAt < CONFIG_CACHE_TTL_MS) {
      return;
    }
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.refreshInFlight,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, COLD_READ_BUDGET_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastRefreshFailureAt = 0;
  }

  /** Effective multi-step settings over the current snapshot. */
  getMultiStep(): ResolvedMultiStepConfig {
    return resolveMultiStepConfig(this.config, isAllowedAssessorModel);
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      this.storage = createWebSearchConfigBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readWebSearchConfig(this.getStorage());
      if (epochAtEntry !== this.epoch) return;
      this.config = result?.config ?? null;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastRefreshFailureAt = 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[web-search-config] refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'code defaults'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}
