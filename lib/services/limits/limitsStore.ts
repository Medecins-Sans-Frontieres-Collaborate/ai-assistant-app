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
import { Session } from 'next-auth';

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

import { AzureBlobStorage, BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

export { AgentAccessConflictError as LimitsConflictError };

/**
 * Counters and policy always live in the PRIMARY region's storage account.
 * Account + container are passed explicitly so `getEnvVariable`'s per-user EU
 * mapping never applies — otherwise counters would shard across the US and EU
 * accounts by caller region and an org-wide total would be unreadable.
 *
 * Residency note: a usage document holds an Entra oid GUID and integers. No
 * mail, no content. Structurally identical to what agent-access rules already
 * do.
 */
const SYSTEM_USER: Session['user'] = {
  id: 'system-usage-limits',
  displayName: 'usage-limits',
};

export function createLimitsBlobStorage(): BlobStorage {
  const accountName = env.AZURE_BLOB_STORAGE_NAME;
  // Same fallback convention as blobStorageFactory: environments without a
  // dedicated container use the image container for all app storage.
  const containerName =
    env.AZURE_BLOB_STORAGE_CONTAINER ?? env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER;
  if (!accountName || !containerName) {
    throw new Error(
      'Usage limits require AZURE_BLOB_STORAGE_NAME and a container (AZURE_BLOB_STORAGE_CONTAINER or AZURE_BLOB_STORAGE_IMAGE_CONTAINER)',
    );
  }
  return new AzureBlobStorage(accountName, containerName, SYSTEM_USER);
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
