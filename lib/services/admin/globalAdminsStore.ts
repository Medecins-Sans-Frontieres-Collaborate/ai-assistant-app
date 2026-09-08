/**
 * Blob persistence for the config-based global admin roster and its history.
 *
 * One document (`system/admin/global-admins.json`), CAS'd like every other
 * admin document (lib/services/agentAccess/blobCas.ts explains why
 * `AzureBlobStorage.upload()` must never be used: its same-length dedupe would
 * silently drop a roster edit that keeps the byte length). A parse failure is
 * loud and total — the service then serves env-only, never a partial roster.
 *
 * Lives in the centralized ADMIN storage (EU account, lifecycle-free
 * container) with the other admin/system stores; see
 * lib/services/adminBlobStorage.ts.
 */
import {
  GLOBAL_ADMINS_PATH,
  GlobalAdminRoster,
  GlobalAdminRosterHistoryEntry,
  GlobalAdminRosterHistoryEntrySchema,
  GlobalAdminRosterSchema,
  globalAdminsHistoryBlobPath,
} from '@/lib/services/admin/globalAdminsTypes';
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as GlobalAdminsConflictError };

/**
 * Throws synchronously when no storage account is configured at all — callers
 * that must never throw (the roster service) call this inside their try.
 */
export function createGlobalAdminsBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface GlobalAdminsReadResult {
  roster: GlobalAdminRoster;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/**
 * Client-side deadline on one roster read (see `readGlobalAdmins`). Well
 * above any healthy read of a few-KB document and below the 60 s cache TTL,
 * so a stalled storage connection surfaces as ONE bounded failure per
 * cooldown window instead of a promise that never settles.
 */
export const ROSTER_READ_DEADLINE_MS = 15_000;

export interface ReadGlobalAdminsOptions {
  /** Overrides {@link ROSTER_READ_DEADLINE_MS} (tests). */
  readDeadlineMs?: number;
}

/**
 * Reads and parses the roster. Returns null when none has been written yet.
 *
 * Bounded by `ROSTER_READ_DEADLINE_MS` through `downloadBlob`'s abort signal:
 * `withAzureRetry` has no time budget of its own, so without the signal a
 * stalled connection would keep this promise pending indefinitely. Past the
 * deadline the read rejects with an `AbortError`, which
 * GlobalAdminRosterService treats like any failed refresh (last-known-good or
 * env-only, plus the failure cooldown). The service additionally bounds the
 * WAIT on this promise (stale-while-revalidate + a 2.5 s cold deadline), so
 * no request ever blocks on the full read deadline.
 */
export async function readGlobalAdmins(
  storage: BlobStorage,
  options: ReadGlobalAdminsOptions = {},
): Promise<GlobalAdminsReadResult | null> {
  const result = await downloadBlob(
    storage,
    GLOBAL_ADMINS_PATH,
    'globalAdmins.read',
    {
      abortSignal: AbortSignal.timeout(
        options.readDeadlineMs ?? ROSTER_READ_DEADLINE_MS,
      ),
    },
  );
  if (result === null) return null;
  const roster = GlobalAdminRosterSchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { roster, etag: result.etag };
}

/**
 * Compare-and-swap roster write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). 412 → {@link GlobalAdminsConflictError}, which the
 * route maps to 409. Returns the new ETag.
 */
export async function writeGlobalAdmins(
  storage: BlobStorage,
  roster: GlobalAdminRoster,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = GlobalAdminRosterSchema.parse(roster);
  return uploadJson(
    storage,
    GLOBAL_ADMINS_PATH,
    parsed,
    ifMatchEtag,
    'globalAdmins.write',
  );
}

/**
 * Immutable audit copy of every successful roster write. Best-effort by
 * design: a history failure must never fail the write the admin just made,
 * but it IS logged loudly. Create-only, so a 412 (same timestamp and author,
 * i.e. a retry) is idempotent success rather than an error.
 */
export async function writeGlobalAdminsHistoryEntry(
  storage: BlobStorage,
  entry: GlobalAdminRosterHistoryEntry,
): Promise<void> {
  const parsed = GlobalAdminRosterHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      globalAdminsHistoryBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'globalAdmins.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[global-admins] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
