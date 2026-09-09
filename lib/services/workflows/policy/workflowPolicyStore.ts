/**
 * Blob persistence for the workflow policy (see types.ts for the model).
 *
 * Same discipline as the limits store: one document, CAS writes only (never
 * `AzureBlobStorage.upload()` — see lib/services/agentAccess/blobCas.ts),
 * best-effort immutable history copy on every successful write.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  WORKFLOW_POLICY_PATH,
  WorkflowPolicy,
  WorkflowPolicyHistoryEntry,
  WorkflowPolicyHistoryEntrySchema,
  WorkflowPolicySchema,
  historyBlobPath,
} from '@/lib/services/workflows/policy/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as WorkflowPolicyConflictError };

export function createWorkflowPolicyBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface WorkflowPolicyReadResult {
  policy: WorkflowPolicy;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/** Reads and parses the policy. Returns null when none has been written yet. */
export async function readWorkflowPolicy(
  storage: BlobStorage,
): Promise<WorkflowPolicyReadResult | null> {
  const result = await downloadBlob(
    storage,
    WORKFLOW_POLICY_PATH,
    'workflows.readPolicy',
  );
  if (result === null) return null;
  const policy = WorkflowPolicySchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { policy, etag: result.etag };
}

/**
 * Compare-and-swap write. `ifMatchEtag` null → creation only. 412 →
 * {@link AgentAccessConflictError}, which the route maps to 409.
 */
export async function writeWorkflowPolicy(
  storage: BlobStorage,
  policy: WorkflowPolicy,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = WorkflowPolicySchema.parse(policy);
  return uploadJson(
    storage,
    WORKFLOW_POLICY_PATH,
    parsed,
    ifMatchEtag,
    'workflows.writePolicy',
  );
}

/** Best-effort audit copy; never fails the write the admin just made. */
export async function writeWorkflowPolicyHistory(
  storage: BlobStorage,
  entry: WorkflowPolicyHistoryEntry,
): Promise<void> {
  const parsed = WorkflowPolicyHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      historyBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'workflows.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[workflows-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
