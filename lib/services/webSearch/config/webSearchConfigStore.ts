/**
 * Blob persistence for the web search configuration (see types.ts).
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
  WEB_SEARCH_CONFIG_PATH,
  WebSearchConfig,
  WebSearchConfigHistoryEntry,
  WebSearchConfigHistoryEntrySchema,
  WebSearchConfigSchema,
  historyBlobPath,
} from '@/lib/services/webSearch/config/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as WebSearchConfigConflictError };

export function createWebSearchConfigBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface WebSearchConfigReadResult {
  config: WebSearchConfig;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/** Reads and parses the config. Returns null when none has been written. */
export async function readWebSearchConfig(
  storage: BlobStorage,
): Promise<WebSearchConfigReadResult | null> {
  const result = await downloadBlob(
    storage,
    WEB_SEARCH_CONFIG_PATH,
    'webSearch.readConfig',
  );
  if (result === null) return null;
  const config = WebSearchConfigSchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { config, etag: result.etag };
}

/**
 * Compare-and-swap write. `ifMatchEtag` null → creation only. 412 →
 * {@link AgentAccessConflictError}, which the route maps to 409.
 */
export async function writeWebSearchConfig(
  storage: BlobStorage,
  config: WebSearchConfig,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = WebSearchConfigSchema.parse(config);
  return uploadJson(
    storage,
    WEB_SEARCH_CONFIG_PATH,
    parsed,
    ifMatchEtag,
    'webSearch.writeConfig',
  );
}

/** Best-effort audit copy; never fails the write the admin just made. */
export async function writeWebSearchConfigHistory(
  storage: BlobStorage,
  entry: WebSearchConfigHistoryEntry,
): Promise<void> {
  const parsed = WebSearchConfigHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      historyBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'webSearch.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[web-search-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
