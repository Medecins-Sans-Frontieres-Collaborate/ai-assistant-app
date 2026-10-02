/**
 * Background upkeep of the analytics store: validate files the ETL delivered
 * or replaced, and delete files past their folder's retention. Server-only.
 *
 * There is no scheduler. A run is started — and not awaited — by the routes
 * that list files, so new deliveries are validated shortly after anyone looks.
 * Nothing a user sees depends on WHEN a run happens: an unvalidated file is
 * simply hidden from non-admins, and an expired one is filtered at read time.
 *
 * Single-flight per replica, and one replica at a time across replicas via a
 * claim blob. A run that dies leaves the claim behind; it is ignored once it
 * is CLAIM_STALE_MS old.
 *
 * DELETION RAILS — expiry removes real files, so it is deliberately narrow:
 *  - only when ANALYTICS_RETENTION_DELETE_ENABLED is on;
 *  - only once a folder overlay has been SAVED. Before that every folder
 *    resolves to the default retention, and a folder an admin meant to keep
 *    longer (finance records) would be cut at the default;
 *  - never while the overlay is unavailable, for the same reason;
 *  - only after the file has been expired for the grace period.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { indexFolders } from '@/lib/services/analytics/access';
import { updateStateDocument } from '@/lib/services/analytics/analyticsStore';
import { analyticsFileId } from '@/lib/services/analytics/deliveryStore';
import { isStateCurrent } from '@/lib/services/analytics/fileState';
import { runHeavy } from '@/lib/services/analytics/heavyWork';
import { folderOfFile } from '@/lib/services/analytics/paths';
import {
  deletePreview,
  writePreview,
} from '@/lib/services/analytics/previewStore';
import {
  effectiveRetentionMonths,
  expiryOf,
  isDeletable,
} from '@/lib/services/analytics/retention';
import { FileRollup, ROLLUP_VERSION } from '@/lib/services/analytics/rollup';
import {
  deleteRollup,
  writeRollup,
} from '@/lib/services/analytics/rollupStore';
import { DerivedTable } from '@/lib/services/analytics/tables';
import {
  ANALYTICS_MAINTENANCE_CLAIM_PATH,
  ANALYTICS_PREVIEW_VERSION,
  AnalyticsFileState,
  DeliveredBlob,
} from '@/lib/services/analytics/types';
import {
  needsContent,
  validateDelivery,
} from '@/lib/services/analytics/validate';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

/** Bounded per run; whatever is left is picked up by the next one. */
const MAX_VALIDATE_PER_RUN = 25;
const MAX_DELETE_PER_RUN = 50;
const CLAIM_STALE_MS = 10 * 60_000;
/** Minimum gap between runs started on this replica. */
const MIN_RUN_INTERVAL_MS = 20_000;

export interface MaintenanceReport {
  ran: boolean;
  validated: number;
  deleted: number;
  /** Files still waiting for validation after this run. */
  remaining: number;
}

const IDLE: MaintenanceReport = {
  ran: false,
  validated: 0,
  deleted: 0,
  remaining: 0,
};

async function acquireClaim(service: AnalyticsService): Promise<boolean> {
  const storage = service.getAdminStorage();
  const existing = await downloadBlob(
    storage,
    ANALYTICS_MAINTENANCE_CLAIM_PATH,
    'analytics.readClaim',
  );
  let condition: string | null = null;
  if (existing) {
    let claimedAt = 0;
    try {
      claimedAt = Date.parse(
        (JSON.parse(existing.buffer.toString('utf8')) as { at?: string }).at ??
          '',
      );
    } catch {
      // An unparseable claim is treated as stale.
    }
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < CLAIM_STALE_MS) {
      return false;
    }
    condition = existing.etag;
  }
  try {
    await uploadJson(
      storage,
      ANALYTICS_MAINTENANCE_CLAIM_PATH,
      { at: new Date().toISOString() },
      condition,
      'analytics.writeClaim',
    );
    return true;
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return false;
    throw error;
  }
}

async function releaseClaim(service: AnalyticsService): Promise<void> {
  try {
    await service
      .getAdminStorage()
      .deleteIfExists(ANALYTICS_MAINTENANCE_CLAIM_PATH);
  } catch (error) {
    console.warn(
      `[analytics] could not release the maintenance claim: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Writes (or removes) the stored preview and rollup that go with a fresh
 * validation record, and stamps the record with what is actually in storage.
 * Derived data that cannot be written is not a verdict on the file: the
 * record is kept without it, and the file stays listable and downloadable.
 */
async function storeDerived(
  service: AnalyticsService,
  id: string,
  state: AnalyticsFileState,
  tables: DerivedTable[] | null,
  rollup: FileRollup | null,
): Promise<AnalyticsFileState> {
  const storage = service.getAdminStorage();
  let stamped = state;
  try {
    if (tables === null) {
      // Quarantined, raw or unreadable: make sure no older preview lingers.
      await deletePreview(storage, id);
    } else {
      await writePreview(storage, id, state.blobVersion, tables);
      stamped = { ...stamped, previewVersion: ANALYTICS_PREVIEW_VERSION };
    }
  } catch (error) {
    console.warn(
      `[analytics] could not store the preview of ${sanitizeForLog(state.path)}: ${sanitizeForLog(error)}`,
    );
  }
  try {
    if (rollup === null) {
      await deleteRollup(storage, id);
    } else {
      await writeRollup(storage, id, rollup);
      stamped = { ...stamped, rollupVersion: ROLLUP_VERSION };
    }
  } catch (error) {
    console.warn(
      `[analytics] could not store the rollup of ${sanitizeForLog(state.path)}: ${sanitizeForLog(error)}`,
    );
  }
  return stamped;
}

/** One maintenance pass. Exported for tests and the admin "re-check". */
export async function runAnalyticsMaintenance(
  now: Date = new Date(),
): Promise<MaintenanceReport> {
  const service = AnalyticsService.getInstance();
  await service.ensureFresh();
  const snapshot = service.getSnapshot();
  // Validating against an overlay that failed to load would judge every file
  // by the wrong report type; wait for it.
  if (snapshot.deliveryUnavailable || snapshot.foldersUnavailable) return IDLE;

  const folders = indexFolders(snapshot.folders?.folders);
  const stored = snapshot.state?.files ?? {};
  const listedIds = new Set<string>();
  const pending: DeliveredBlob[] = [];
  const deletable: DeliveredBlob[] = [];
  const deletionAllowed =
    env.ANALYTICS_RETENTION_DELETE_ENABLED && snapshot.folders !== null;

  for (const blob of snapshot.blobs) {
    const id = analyticsFileId(blob.path);
    listedIds.add(id);
    const expiresAt = expiryOf(
      blob,
      effectiveRetentionMonths(folderOfFile(blob.path), folders),
    );
    if (deletionAllowed && isDeletable(expiresAt, now)) {
      deletable.push(blob);
    } else if (!isStateCurrent(stored[id], blob, folders)) {
      pending.push(blob);
    }
  }
  const orphaned = Object.keys(stored).filter((id) => !listedIds.has(id));
  if (pending.length === 0 && deletable.length === 0 && orphaned.length === 0) {
    return IDLE;
  }
  if (!(await acquireClaim(service))) {
    return { ...IDLE, remaining: pending.length };
  }

  const results = new Map<string, AnalyticsFileState>();
  const removed: string[] = [...orphaned];
  try {
    const delivery = service.getDeliveryStore();
    for (const blob of pending.slice(0, MAX_VALIDATE_PER_RUN)) {
      const id = analyticsFileId(blob.path);
      try {
        const content = needsContent(blob)
          ? await delivery.download(blob.path)
          : null;
        // Gone between the listing and the read: the next listing drops it.
        if (needsContent(blob) && content === null) continue;
        // One heavy parse at a time on this replica, exports included.
        const { state, tables, rollup } = await runHeavy(() =>
          validateDelivery({
            blob,
            content,
            folders,
            previous: stored[id] ?? null,
            now,
          }),
        );
        results.set(id, await storeDerived(service, id, state, tables, rollup));
      } catch (error) {
        // A storage failure is not a verdict on the file: leave it pending.
        console.warn(
          `[analytics] validation of ${sanitizeForLog(blob.path)} could not run: ${sanitizeForLog(error)}`,
        );
      }
    }

    for (const blob of deletable.slice(0, MAX_DELETE_PER_RUN)) {
      try {
        await delivery.delete(blob.path);
        removed.push(analyticsFileId(blob.path));
        console.log(
          `[analytics-audit] action=expire path=${sanitizeForLog(blob.path)}`,
        );
      } catch (error) {
        console.error(
          `[analytics] could not delete expired ${sanitizeForLog(blob.path)}: ${sanitizeForLog(error)}`,
        );
      }
    }

    // A file that is gone takes its stored preview and rollup with it.
    for (const id of removed) {
      try {
        await deletePreview(service.getAdminStorage(), id);
        await deleteRollup(service.getAdminStorage(), id);
      } catch (error) {
        console.warn(
          `[analytics] could not delete the derived data of ${sanitizeForLog(id)}: ${sanitizeForLog(error)}`,
        );
      }
    }

    if (results.size > 0 || removed.length > 0) {
      await updateStateDocument(
        service.getAdminStorage(),
        (files) => {
          for (const id of removed) delete files[id];
          for (const [id, state] of results) files[id] = state;
        },
        now,
      );
      service.invalidateFiles();
    }
  } finally {
    await releaseClaim(service);
  }

  return {
    ran: true,
    validated: results.size,
    deleted: removed.length - orphaned.length,
    remaining: Math.max(0, pending.length - results.size),
  };
}

let running: Promise<MaintenanceReport> | null = null;
let lastStartedAt = 0;

/**
 * Starts a run in the background unless one is in flight or one started very
 * recently (`force` skips the recency check — an admin asked for a re-check).
 * Never throws and never needs awaiting.
 */
export function scheduleAnalyticsMaintenance(
  options: { force?: boolean } = {},
): void {
  if (running) return;
  if (!options.force && Date.now() - lastStartedAt < MIN_RUN_INTERVAL_MS) {
    return;
  }
  lastStartedAt = Date.now();
  running = runAnalyticsMaintenance()
    .catch((error) => {
      console.error(`[analytics] maintenance failed: ${sanitizeForLog(error)}`);
      return IDLE;
    })
    .finally(() => {
      running = null;
    });
}

/** Test hook. */
export function __resetAnalyticsMaintenanceForTests(): void {
  running = null;
  lastStartedAt = 0;
}
