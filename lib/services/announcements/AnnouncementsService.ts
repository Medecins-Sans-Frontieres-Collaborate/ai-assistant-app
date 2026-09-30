/**
 * Per-process singleton serving the announcements document to the
 * `/api/version` funnel.
 *
 * The funnel is polled by every open client, so this cache is what keeps it
 * at one blob read per replica per TTL rather than one per poll. A SHORT TTL
 * (30 s) because "when it sends" is a promise admins make to users; combined
 * with the client's poll interval it bounds how late a message can appear.
 *
 * Failure posture: no snapshot → no announcements. An announcements outage
 * must never block or degrade the app — and never the refresh banner that
 * shares the funnel.
 */
import {
  createAnnouncementsBlobStorage,
  readAnnouncements,
} from '@/lib/services/announcements/announcementsStore';
import { AnnouncementsDocument } from '@/lib/services/announcements/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const CACHE_TTL_MS = 30_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
const READ_DEADLINE_MS = 4_000;

export class AnnouncementsService {
  private static instance: AnnouncementsService | null = null;

  private storage: BlobStorage | null = null;
  private document: AnnouncementsDocument | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): AnnouncementsService {
    if (!AnnouncementsService.instance) {
      AnnouncementsService.instance = new AnnouncementsService();
    }
    return AnnouncementsService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    AnnouncementsService.instance = null;
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

  /** Null until a read has succeeded, and when nothing has been authored. */
  getDocument(): AnnouncementsDocument | null {
    return this.document;
  }

  private getStorage(): BlobStorage {
    if (!this.storage) this.storage = createAnnouncementsBlobStorage();
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readAnnouncements(this.getStorage(), {
        abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
      });
      if (epochAtEntry !== this.epoch) return;
      this.document = result?.document ?? null;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastRefreshFailureAt = 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[announcements] refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'none'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}
