/**
 * Blob persistence for the analytics documents in the ADMIN container: the
 * folder overlay, the field policy and the validation state (see types.ts).
 *
 * Same discipline as the delegations and limits stores: CAS writes only
 * (never `AzureBlobStorage.upload()` — see lib/services/agentAccess/
 * blobCas.ts), and a best-effort immutable history copy for the two
 * admin-authored documents.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  DownloadBlobOptions,
  OVERWRITE_BLOB,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  ANALYTICS_FIELD_POLICY_HISTORY_PREFIX,
  ANALYTICS_FIELD_POLICY_PATH,
  ANALYTICS_FOLDERS_HISTORY_PREFIX,
  ANALYTICS_FOLDERS_PATH,
  ANALYTICS_STATE_PATH,
  AnalyticsFieldPolicyDocument,
  AnalyticsFieldPolicyDocumentSchema,
  AnalyticsFileState,
  AnalyticsFoldersDocument,
  AnalyticsFoldersDocumentSchema,
  AnalyticsStateDocument,
  AnalyticsStateDocumentSchema,
  analyticsHistoryBlobPath,
} from '@/lib/services/analytics/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { z } from 'zod';

export { AgentAccessConflictError as AnalyticsConflictError };

export function createAnalyticsAdminStorage(): BlobStorage {
  return createAdminBlobStorage();
}

/** The document exists but is not JSON its read schema accepts. */
export class AnalyticsUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Stored analytics document ${path} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'AnalyticsUnreadableError';
  }
}

export interface DocumentRead<T> {
  document: T;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

async function readDocument<T>(
  storage: BlobStorage,
  path: string,
  schema: z.ZodType<T>,
  label: string,
  options: DownloadBlobOptions,
): Promise<DocumentRead<T> | null> {
  const result = await downloadBlob(storage, path, label, options);
  if (result === null) return null;
  try {
    return {
      document: schema.parse(JSON.parse(result.buffer.toString('utf8'))),
      etag: result.etag,
    };
  } catch (error) {
    throw new AnalyticsUnreadableError(path, error);
  }
}

/** Best-effort audit copy; never fails the write the admin just made. */
async function writeHistory(
  storage: BlobStorage,
  prefix: string,
  document: { updatedBy: string; updatedAt: string },
  label: string,
): Promise<void> {
  try {
    await uploadJson(
      storage,
      analyticsHistoryBlobPath(prefix, document.updatedAt, document.updatedBy),
      {
        version: 1,
        document,
        updatedBy: document.updatedBy,
        updatedAt: document.updatedAt,
      },
      null,
      label,
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[analytics-admin] HISTORY WRITE FAILED ${sanitizeForLog(label)} by=${sanitizeForLog(document.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}

/** Null when no folder configuration has ever been saved. */
export function readFoldersDocument(
  storage: BlobStorage,
  options: DownloadBlobOptions = {},
): Promise<DocumentRead<AnalyticsFoldersDocument> | null> {
  return readDocument(
    storage,
    ANALYTICS_FOLDERS_PATH,
    AnalyticsFoldersDocumentSchema,
    'analytics.readFolders',
    options,
  );
}

/** CAS write. `ifMatchEtag` null → creation only. 412 → conflict error. */
export async function writeFoldersDocument(
  storage: BlobStorage,
  document: AnalyticsFoldersDocument,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = AnalyticsFoldersDocumentSchema.parse(document);
  const etag = await uploadJson(
    storage,
    ANALYTICS_FOLDERS_PATH,
    parsed,
    ifMatchEtag,
    'analytics.writeFolders',
  );
  await writeHistory(
    storage,
    ANALYTICS_FOLDERS_HISTORY_PREFIX,
    parsed,
    'analytics.writeFoldersHistory',
  );
  return etag;
}

export function readFieldPolicyDocument(
  storage: BlobStorage,
  options: DownloadBlobOptions = {},
): Promise<DocumentRead<AnalyticsFieldPolicyDocument> | null> {
  return readDocument(
    storage,
    ANALYTICS_FIELD_POLICY_PATH,
    AnalyticsFieldPolicyDocumentSchema,
    'analytics.readFieldPolicy',
    options,
  );
}

export async function writeFieldPolicyDocument(
  storage: BlobStorage,
  document: AnalyticsFieldPolicyDocument,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = AnalyticsFieldPolicyDocumentSchema.parse(document);
  const etag = await uploadJson(
    storage,
    ANALYTICS_FIELD_POLICY_PATH,
    parsed,
    ifMatchEtag,
    'analytics.writeFieldPolicy',
  );
  await writeHistory(
    storage,
    ANALYTICS_FIELD_POLICY_HISTORY_PREFIX,
    parsed,
    'analytics.writeFieldPolicyHistory',
  );
  return etag;
}

export function readStateDocument(
  storage: BlobStorage,
  options: DownloadBlobOptions = {},
): Promise<DocumentRead<AnalyticsStateDocument> | null> {
  return readDocument(
    storage,
    ANALYTICS_STATE_PATH,
    AnalyticsStateDocumentSchema,
    'analytics.readState',
    options,
  );
}

const STATE_CAS_ATTEMPTS = 4;

/**
 * Read-modify-write of the validation state. Several replicas validate at
 * once, so the change is expressed as a function and re-applied to a fresh
 * read when another writer won. An unreadable stored document is replaced
 * rather than fatal: the state is derived data and is rebuilt by validation.
 */
export async function updateStateDocument(
  storage: BlobStorage,
  change: (files: Record<string, AnalyticsFileState>) => void,
  now: Date,
): Promise<AnalyticsStateDocument> {
  for (let attempt = 1; ; attempt++) {
    let current: DocumentRead<AnalyticsStateDocument> | null = null;
    let replaceUnreadable = false;
    try {
      current = await readStateDocument(storage);
    } catch (error) {
      if (!(error instanceof AnalyticsUnreadableError)) throw error;
      replaceUnreadable = true;
    }
    const files = { ...(current?.document.files ?? {}) };
    change(files);
    const next: AnalyticsStateDocument = {
      ...(current?.document ?? {}),
      version: 1,
      files,
      updatedAt: now.toISOString(),
    };
    try {
      // Unconditional when the stored copy could not be parsed (see the doc
      // comment): there is no ETag to match against it.
      await uploadJson(
        storage,
        ANALYTICS_STATE_PATH,
        next,
        replaceUnreadable ? OVERWRITE_BLOB : (current?.etag ?? null),
        'analytics.writeState',
      );
      return next;
    } catch (error) {
      if (
        error instanceof AgentAccessConflictError &&
        attempt < STATE_CAS_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
}
