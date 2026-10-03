/**
 * Per-process singleton serving the context budget configuration.
 *
 * Caching contract mirrors WebSearchConfigService: `await ensureFresh()`
 * (no-op while the 60s TTL is warm), then read `getBudget()`
 * synchronously. Single-flight refresh, epoch guard so an `invalidate()`
 * landing mid-refresh is not lost, 5s failure cooldown, last-known-good
 * retention.
 *
 * Failure posture: there is none to choose. With no snapshot at all — cold
 * start during a storage outage, or nothing authored yet — `getBudget()`
 * answers from the code defaults in types.ts. A chat turn must never wait
 * on, or fail because of, this document.
 */
import {
  createContextBudgetConfigBlobStorage,
  readContextBudgetConfig,
} from '@/lib/services/contextBudget/contextBudgetStore';
import {
  ContextBudgetConfig,
  HistoryBudget,
  ResolvedContextBudgetConfig,
  resolveContextBudgetConfig,
  resolveHistoryBudget,
} from '@/lib/services/contextBudget/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { OpenAIModel } from '@/types/openai';

const CONFIG_CACHE_TTL_MS = 60_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
// A cold replica must not hold a user's turn hostage to a slow blob read:
// past this, the turn proceeds on the defaults and the refresh finishes in
// the background for the next request.
const COLD_READ_BUDGET_MS = 2_500;

export class ContextBudgetService {
  private static instance: ContextBudgetService | null = null;

  private storage: BlobStorage | null = null;
  private config: ContextBudgetConfig | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): ContextBudgetService {
    if (!ContextBudgetService.instance) {
      ContextBudgetService.instance = new ContextBudgetService();
    }
    return ContextBudgetService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    ContextBudgetService.instance = null;
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

  /** Effective settings over the current snapshot. */
  getConfig(): ResolvedContextBudgetConfig {
    return resolveContextBudgetConfig(this.config);
  }

  /** The history budget for one model under the current snapshot. */
  getBudget(
    model: Pick<OpenAIModel, 'id' | 'maxLength' | 'tokenLimit' | 'series'>,
  ): HistoryBudget {
    return resolveHistoryBudget(model, this.getConfig());
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      this.storage = createContextBudgetConfigBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readContextBudgetConfig(this.getStorage());
      if (epochAtEntry !== this.epoch) return;
      this.config = result?.config ?? null;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastRefreshFailureAt = 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[context-budget-config] refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'code defaults'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}
