/**
 * Blob persistence for the context budget configuration (see types.ts).
 *
 * Same discipline as the workflow policy store: one document, CAS writes
 * only (never `AzureBlobStorage.upload()` — see
 * lib/services/agentAccess/blobCas.ts), best-effort immutable history copy
 * on every successful write.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  CONTEXT_BUDGET_CONFIG_PATH,
  ContextBudgetConfig,
  ContextBudgetConfigHistoryEntry,
  ContextBudgetConfigHistoryEntrySchema,
  ContextBudgetConfigSchema,
  historyBlobPath,
} from '@/lib/services/contextBudget/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as ContextBudgetConfigConflictError };

export function createContextBudgetConfigBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface ContextBudgetConfigReadResult {
  config: ContextBudgetConfig;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/** Reads and parses the config. Returns null when none has been written. */
export async function readContextBudgetConfig(
  storage: BlobStorage,
): Promise<ContextBudgetConfigReadResult | null> {
  const result = await downloadBlob(
    storage,
    CONTEXT_BUDGET_CONFIG_PATH,
    'contextBudget.readConfig',
  );
  if (result === null) return null;
  const config = ContextBudgetConfigSchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { config, etag: result.etag };
}

/**
 * Compare-and-swap write. `ifMatchEtag` null → creation only. 412 →
 * {@link AgentAccessConflictError}, which the route maps to 409.
 */
export async function writeContextBudgetConfig(
  storage: BlobStorage,
  config: ContextBudgetConfig,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = ContextBudgetConfigSchema.parse(config);
  return uploadJson(
    storage,
    CONTEXT_BUDGET_CONFIG_PATH,
    parsed,
    ifMatchEtag,
    'contextBudget.writeConfig',
  );
}

/** Best-effort audit copy; never fails the write the admin just made. */
export async function writeContextBudgetConfigHistory(
  storage: BlobStorage,
  entry: ContextBudgetConfigHistoryEntry,
): Promise<void> {
  const parsed = ContextBudgetConfigHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      historyBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'contextBudget.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[context-budget-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
