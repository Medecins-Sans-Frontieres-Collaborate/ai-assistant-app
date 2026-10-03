/**
 * Per-process singleton serving everything the analytics surfaces read: the
 * folder overlay, the field policy, the validation state and the delivery
 * listing.
 *
 * Caching contract mirrors DelegationsService: `await ensureFresh()` (a no-op
 * while the TTLs are warm), then read the snapshot synchronously. Each part
 * refreshes single-flight, keeps its last-known-good value on failure, and
 * backs off for a few seconds after one.
 *
 * Failure posture — every part fails CLOSED for non-admins:
 *  - no folder overlay ever loaded → nobody but admins has any folder;
 *  - no field policy ever loaded   → originals are not downloadable;
 *  - no validation state           → every file counts as not yet validated;
 *  - no listing                    → there are no files.
 */
import {
  createAnalyticsAdminStorage,
  readFieldPolicyDocument,
  readFoldersDocument,
  readStateDocument,
} from '@/lib/services/analytics/analyticsStore';
import {
  DeliveryStore,
  createDeliveryStore,
} from '@/lib/services/analytics/deliveryStore';
import {
  AnalyticsFieldPolicyDocument,
  AnalyticsFoldersDocument,
  AnalyticsStateDocument,
  DeliveredBlob,
} from '@/lib/services/analytics/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const CONFIG_TTL_MS = 60_000;
/** Shorter: validation results and new deliveries should show up promptly. */
const STATE_TTL_MS = 15_000;
const LISTING_TTL_MS = 30_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
const READ_DEADLINE_MS = 8_000;

/** One cached value: TTL, single-flight refresh, last-known-good on failure. */
class Cached<T> {
  private value: T | undefined;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastFailureAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly label: string,
    private readonly ttlMs: number,
    private readonly load: () => Promise<T>,
  ) {}

  async ensureFresh(): Promise<void> {
    if (this.loadedOnce && Date.now() - this.fetchedAt < this.ttlMs) return;
    if (
      this.lastFailureAt !== 0 &&
      Date.now() - this.lastFailureAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
  }

  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastFailureAt = 0;
  }

  /** The last successfully loaded value; undefined until one has loaded. */
  get(): T | undefined {
    return this.value;
  }

  get unavailable(): boolean {
    return !this.loadedOnce;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const value = await this.load();
      if (epochAtEntry !== this.epoch) return;
      this.value = value;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastFailureAt = 0;
    } catch (error) {
      this.lastFailureAt = Date.now();
      console.error(
        `[analytics] ${this.label} refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'nothing'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}

export interface AnalyticsSnapshot {
  /** Null = no overlay saved yet (or none loaded — see `foldersUnavailable`). */
  folders: AnalyticsFoldersDocument | null;
  foldersUnavailable: boolean;
  policy: AnalyticsFieldPolicyDocument | null;
  policyUnavailable: boolean;
  state: AnalyticsStateDocument | null;
  stateUnavailable: boolean;
  blobs: DeliveredBlob[];
  /** The delivery container could not be listed on this replica. */
  deliveryUnavailable: boolean;
}

export class AnalyticsService {
  private static instance: AnalyticsService | null = null;

  private adminStorage: BlobStorage | null = null;
  private deliveryStore: DeliveryStore | null = null;

  private readonly folders = new Cached('folders', CONFIG_TTL_MS, async () => {
    const result = await readFoldersDocument(this.getAdminStorage(), {
      abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
    });
    return result?.document ?? null;
  });

  private readonly policy = new Cached(
    'field policy',
    CONFIG_TTL_MS,
    async () => {
      const result = await readFieldPolicyDocument(this.getAdminStorage(), {
        abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
      });
      return result?.document ?? null;
    },
  );

  private readonly state = new Cached('state', STATE_TTL_MS, async () => {
    const result = await readStateDocument(this.getAdminStorage(), {
      abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
    });
    return result?.document ?? null;
  });

  private readonly listing = new Cached('listing', LISTING_TTL_MS, () =>
    this.getDeliveryStore().list(),
  );

  static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService();
    }
    return AnalyticsService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    AnalyticsService.instance = null;
  }

  /** Refreshes only the overlay — enough for "may this person open anything". */
  async ensureFoldersFresh(): Promise<void> {
    await this.folders.ensureFresh();
  }

  async ensureFresh(): Promise<void> {
    await Promise.all([
      this.folders.ensureFresh(),
      this.policy.ensureFresh(),
      this.state.ensureFresh(),
      this.listing.ensureFresh(),
    ]);
  }

  invalidateConfig(): void {
    this.folders.invalidate();
    this.policy.invalidate();
  }

  invalidateFiles(): void {
    this.state.invalidate();
    this.listing.invalidate();
  }

  getSnapshot(): AnalyticsSnapshot {
    return {
      folders: this.folders.get() ?? null,
      foldersUnavailable: this.folders.unavailable,
      policy: this.policy.get() ?? null,
      policyUnavailable: this.policy.unavailable,
      state: this.state.get() ?? null,
      stateUnavailable: this.state.unavailable,
      blobs: this.listing.get() ?? [],
      deliveryUnavailable: this.listing.unavailable,
    };
  }

  getAdminStorage(): BlobStorage {
    if (!this.adminStorage) this.adminStorage = createAnalyticsAdminStorage();
    return this.adminStorage;
  }

  getDeliveryStore(): DeliveryStore {
    if (!this.deliveryStore) this.deliveryStore = createDeliveryStore();
    return this.deliveryStore;
  }
}
