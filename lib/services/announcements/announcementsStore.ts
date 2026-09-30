/**
 * Blob persistence for the announcements document (see types.ts).
 *
 * One document, CAS writes only (never `AzureBlobStorage.upload()` — see
 * lib/services/agentAccess/blobCas.ts). Every admin action is a bounded
 * read-modify-write of ONE record (`mutateAnnouncements`), never a
 * whole-document PUT: global admins and delegated senders edit the same
 * document concurrently, and a stale whole-document save would revert
 * somebody else's announcement.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  DownloadBlobOptions,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  ANNOUNCEMENTS_DOCUMENT_PATH,
  AnnouncementsDocument,
  AnnouncementsDocumentSchema,
  AnnouncementsHistoryEntry,
  AnnouncementsHistoryEntrySchema,
  announcementsHistoryBlobPath,
} from '@/lib/services/announcements/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as AnnouncementsConflictError };

export function createAnnouncementsBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface AnnouncementsReadResult {
  document: AnnouncementsDocument;
  etag: string;
}

export function emptyAnnouncementsDocument(): AnnouncementsDocument {
  return {
    version: 1,
    announcements: [],
    allowedLinkHosts: [],
    updatedBy: '',
    updatedAt: '',
  };
}

/** Null when nothing has been written yet. Parse failures propagate. */
export async function readAnnouncements(
  storage: BlobStorage,
  options: DownloadBlobOptions = {},
): Promise<AnnouncementsReadResult | null> {
  const result = await downloadBlob(
    storage,
    ANNOUNCEMENTS_DOCUMENT_PATH,
    'announcements.read',
    options,
  );
  if (result === null) return null;
  const document = AnnouncementsDocumentSchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { document, etag: result.etag };
}

export interface AnnouncementsMutationAbort {
  abort: Response;
}
export type AnnouncementsMutator = (
  current: AnnouncementsDocument,
) =>
  | AnnouncementsDocument
  | AnnouncementsMutationAbort
  | Promise<AnnouncementsDocument | AnnouncementsMutationAbort>;

export type MutateAnnouncementsResult =
  | { document: AnnouncementsDocument; abort?: undefined }
  | { document?: undefined; abort: Response };

const CAS_ATTEMPTS = 3;
const CAS_BASE_BACKOFF_MS = 25;

/**
 * Bounded read-modify-write under CAS. The mutator receives the CURRENT
 * document on every attempt (an empty one when nothing is stored yet), so
 * validation re-runs against fresh data after a 412 — never compute once and
 * re-upload. `{ abort }` stops the loop without writing. After the last lost
 * round the conflict error propagates; routes map it to 409.
 */
export async function mutateAnnouncements(
  storage: BlobStorage,
  mutate: AnnouncementsMutator,
): Promise<MutateAnnouncementsResult> {
  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    const current = await readAnnouncements(storage);
    const outcome = await mutate(
      current?.document ?? emptyAnnouncementsDocument(),
    );
    if (!('version' in outcome)) return { abort: outcome.abort };
    const next = AnnouncementsDocumentSchema.parse(outcome);
    try {
      await uploadJson(
        storage,
        ANNOUNCEMENTS_DOCUMENT_PATH,
        next,
        current?.etag ?? null,
        'announcements.write',
      );
      return { document: next };
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError)) throw error;
      if (attempt >= CAS_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          CAS_BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random()),
        ),
      );
    }
  }
  throw new AgentAccessConflictError();
}

/** Best-effort audit copy; never fails the action the admin just took. */
export async function writeAnnouncementsHistory(
  storage: BlobStorage,
  entry: AnnouncementsHistoryEntry,
): Promise<void> {
  const parsed = AnnouncementsHistoryEntrySchema.parse(entry);
  try {
    await uploadJson(
      storage,
      announcementsHistoryBlobPath(
        parsed.updatedAt,
        parsed.updatedBy,
        parsed.announcement?.id ?? parsed.host ?? 'document',
      ),
      parsed,
      null,
      'announcements.writeHistory',
    );
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[announcements-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
  }
}
