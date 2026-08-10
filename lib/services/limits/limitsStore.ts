/**
 * Blob persistence for the usage-limits policy and its audit history.
 *
 * ONE document (`system/limits/policy.json`), not per-override blobs. This is
 * the single most important structural choice here: with per-override blobs a
 * malformed record fails OPEN — that user silently becomes unlimited, and
 * nobody finds out. With one document a parse failure is loud, total, and
 * falls to the explicit `failMode`. There is no path where one corrupt record
 * un-limits one person.
 *
 * The cost is admin-vs-admin CAS contention (handled by the 409-reload UX)
 * and a size ceiling, which the route's write schema bounds. Stable
 * per-override ids make a later split into `system/limits/overrides/<id>.json`
 * purely additive if that wall is ever hit.
 *
 * ⚠ Lives beside `system/agent-access/`, never underneath its `rules/`
 * prefix: `listAllRules` is fail-closed, so an alien blob there would brick
 * every Foundry agent invocation.
 *
 * CAS discipline (why `AzureBlobStorage.upload()` must never be used) lives
 * in lib/services/agentAccess/blobCas.ts.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  LIMITS_POLICY_PATH,
  LimitsHistoryEntry,
  LimitsHistoryEntrySchema,
  LimitsPolicy,
  LimitsPolicySchema,
  historyBlobPath,
} from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as LimitsConflictError };

/**
 * Counters and policy live in the centralized ADMIN storage (EU account,
 * dedicated lifecycle-free container) shared by every admin/system store —
 * one location for all users, so an org-wide total stays readable and the
 * per-user usage documents (Entra oid + integers) stay EU-resident. See
 * lib/services/adminBlobStorage.ts for the full rationale.
 */
export function createLimitsBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface PolicyReadResult {
  policy: LimitsPolicy;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/** Reads and parses the policy. Returns null when none has been written yet. */
export async function readPolicy(
  storage: BlobStorage,
): Promise<PolicyReadResult | null> {
  const result = await downloadBlob(
    storage,
    LIMITS_POLICY_PATH,
    'limits.readPolicy',
  );
  if (result === null) return null;
  const policy = LimitsPolicySchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { policy, etag: result.etag };
}

/**
 * Compare-and-swap policy write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}, which the
 * route maps to 409. Returns the new ETag.
 */
export async function writePolicy(
  storage: BlobStorage,
  policy: LimitsPolicy,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = LimitsPolicySchema.parse(policy);
  return uploadJson(
    storage,
    LIMITS_POLICY_PATH,
    parsed,
    ifMatchEtag,
    'limits.writePolicy',
  );
}

/**
 * Immutable audit copy of every successful policy write. Best-effort by
 * design: a history failure must never fail the write the admin just made,
 * but it IS logged loudly. Written create-only, so a 412 (same timestamp and
 * author, i.e. a retry) is idempotent success rather than an error.
 */
export async function writeHistoryEntry(
  storage: BlobStorage,
  entry: LimitsHistoryEntry,
): Promise<void> {
  const parsed = LimitsHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      historyBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'limits.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[limits-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
