/**
 * Blob persistence for the shared delegations document (see types.ts).
 *
 * Same discipline as the limits and workflow-policy stores: one document,
 * CAS writes only (never `AzureBlobStorage.upload()` — see
 * lib/services/agentAccess/blobCas.ts), best-effort immutable history copy.
 *
 * A LEAF module on purpose: it knows nothing about the limits policy. The
 * one-time migration out of that policy lives in
 * lib/services/limits/limitsStore.ts (`loadDelegationsDocument`), which is
 * the module that can see both sides — keeping the import graph acyclic.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  DownloadBlobOptions,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  DELEGATIONS_DOCUMENT_PATH,
  DelegationsDocument,
  DelegationsDocumentSchema,
  DelegationsHistoryEntry,
  DelegationsHistoryEntrySchema,
  delegationsHistoryBlobPath,
} from '@/lib/services/delegations/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as DelegationsConflictError };

export function createDelegationsBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface DelegationsReadResult {
  document: DelegationsDocument;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/**
 * The document exists but is not JSON the read schema accepts. Typed so the
 * limits composition can classify it as "policy unavailable" (its explicit
 * `failMode`) instead of quietly serving a policy with no delegations.
 */
export class DelegationsUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      `Stored delegations document is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'DelegationsUnreadableError';
  }
}

/** Reads and parses the document. Null when none has been written yet. */
export async function readDelegationsDocument(
  storage: BlobStorage,
  options: DownloadBlobOptions = {},
): Promise<DelegationsReadResult | null> {
  const result = await downloadBlob(
    storage,
    DELEGATIONS_DOCUMENT_PATH,
    'delegations.read',
    options,
  );
  if (result === null) return null;
  let document: DelegationsDocument;
  try {
    document = DelegationsDocumentSchema.parse(
      JSON.parse(result.buffer.toString('utf8')),
    );
  } catch (error) {
    throw new DelegationsUnreadableError(error);
  }
  return { document, etag: result.etag };
}

/** CAS write. `ifMatchEtag` null → creation only. 412 → conflict error. */
export async function writeDelegationsDocument(
  storage: BlobStorage,
  document: DelegationsDocument,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = DelegationsDocumentSchema.parse(document);
  return uploadJson(
    storage,
    DELEGATIONS_DOCUMENT_PATH,
    parsed,
    ifMatchEtag,
    'delegations.write',
  );
}

/** Best-effort audit copy; never fails the write the admin just made. */
export async function writeDelegationsHistory(
  storage: BlobStorage,
  entry: DelegationsHistoryEntry,
): Promise<void> {
  const parsed = DelegationsHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      delegationsHistoryBlobPath(parsed.updatedAt, parsed.updatedBy),
      parsed,
      null,
      'delegations.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[delegations-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
