import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredBrandBook,
  createAgentAccessBlobStorage,
  deleteBrandBook,
  listAllBrandBooks,
  readBrandBook,
  readConfig,
  writeBrandBook,
  writeBrandBookHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
  delegateToCreator,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AdminBrandBook,
  AdminBrandBookHistoryEntry,
  AgentAccessConfig,
  BRAND_BOOK_ID_PATTERN,
  BRAND_BOOK_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  BrandFileError,
  removeUnusedBrandBookFiles,
  settleBrandBookFiles,
} from '@/lib/services/brand/brandBooks';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';

/**
 * GET/POST/PUT/DELETE /api/agent-access/brand-books: admin CRUD for brand
 * books (docs/DOCUMENT_PLATFORM.md, phase E), exactly like form templates.
 * 404 while agent access is off. Any admin (global or local) may create;
 * edits and deletes are authorized per canonical key (`brand-book::<id>`),
 * and a local admin's new book is delegated to them (rolled back if that
 * fails). Files follow THE BRAND FILE CONVENTION (brandBooks.ts): uploads
 * are copied into the book on save.
 *
 * Body of POST: `{ book }`; of PUT: `{ id, book }` with `If-Match`.
 */

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  return errorResponse(
    'Brand book was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

async function appendHistoryBestEffort(
  entry: AdminBrandBookHistoryEntry,
): Promise<void> {
  try {
    await writeBrandBookHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/** Unused files are removed after a save; a failure only leaves orphans. */
async function tidyFilesBestEffort(
  id: string,
  keep: AdminBrandBook['book'] | null,
): Promise<void> {
  try {
    await removeUnusedBrandBookFiles(id, keep);
  } catch (error) {
    console.error(
      `[agent-access-admin] brand book file cleanup failed for ${sanitizeForLog(id)}: ${sanitizeForLog(error)}`,
    );
  }
}

/** The signed-in admin and their rights, or the response refusing them. */
async function adminOf(service: AgentAccessService) {
  const session = await auth();
  if (!session?.user) return { refused: unauthorizedResponse() } as const;
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { refused: forbiddenResponse() } as const;
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    return { refused: forbiddenResponse() } as const;
  }
  return { session: session as Session, userMail, status } as const;
}

/** Reads `{ book }` (and `id`, for an update) from a request body. */
async function bodyOf(
  request: NextRequest,
  needsId: boolean,
): Promise<
  | { ok: true; id?: string; book: AdminBrandBook['book'] }
  | { ok: false; response: ReturnType<typeof badRequestResponse> }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequestResponse('Invalid JSON body') };
  }
  const value = (raw ?? {}) as { id?: unknown; book?: unknown };
  let id: string | undefined;
  if (needsId) {
    if (typeof value.id !== 'string' || !BRAND_BOOK_ID_PATTERN.test(value.id)) {
      return {
        ok: false,
        response: badRequestResponse('id is not a valid brand book id'),
      };
    }
    id = value.id;
  }
  const parsed = parseBrandBookBody(value.book);
  if (!parsed.ok) {
    return {
      ok: false,
      response: badRequestResponse('Invalid brand book', parsed.error),
    };
  }
  return { ok: true, id, book: parsed.body };
}

export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    let stored: StoredBrandBook[] = [];
    let config: AgentAccessConfig | null = null;
    let booksUnavailable = false;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllBrandBooks(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
    } catch (error) {
      console.error(
        `[agent-access-admin] direct brand-books read failed: ${sanitizeForLog(error)}`,
      );
      booksUnavailable = true;
      config = service.getSnapshot().config;
    }
    const status = resolveAdminStatus(session.user, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? stored
        : stored.filter((entry) => canEditKey(status, entry.canonicalKey));
    return successResponse({
      books: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        record: entry.record,
        etag: entry.etag,
      })),
      booksUnavailable,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list brand books');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const parsed = await bodyOf(request, false);
  if (!parsed.ok) return parsed.response;

  try {
    const admin = await adminOf(service);
    if ('refused' in admin) return admin.refused;
    const { session, userMail, status } = admin;

    const id = `brand-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(BRAND_BOOK_SOURCE, id);
    const now = new Date().toISOString();
    const book = await settleBrandBookFiles(session, id, parsed.book);
    const record: AdminBrandBook = {
      version: 1,
      id,
      book,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };
    const storage = createAgentAccessBlobStorage();
    const etag = await writeBrandBook(storage, record, null);
    service.invalidate();
    auditAdminWrite('brand-book-upsert', canonicalKey, userMail);

    if (!status.isGlobalAdmin) {
      const delegated = await delegateToCreator(userMail, canonicalKey);
      if (!delegated) {
        try {
          await deleteBrandBook(storage, id, etag);
          await tidyFilesBestEffort(id, null);
          auditAdminWrite('brand-book-delete', canonicalKey, userMail);
        } catch (error) {
          console.error(
            `[agent-access-admin] ROLLBACK DELETE FAILED: brand book id=${sanitizeForLog(id)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
          );
          service.invalidate();
          return errorResponse(
            `Could not record delegation AND rollback failed: brand book ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        service.invalidate();
        return errorResponse(
          'Could not record delegation; brand book creation rolled back',
          503,
        );
      }
      service.invalidate();
    }
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof BrandFileError) {
      return badRequestResponse(error.message);
    }
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create brand book');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const parsed = await bodyOf(request, true);
  if (!parsed.ok) return parsed.response;
  const id = parsed.id as string;
  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }
  const canonicalKey = canonicalAgentKey(BRAND_BOOK_SOURCE, id);

  try {
    const admin = await adminOf(service);
    if ('refused' in admin) return admin.refused;
    const { session, userMail, status } = admin;
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this brand book');
    }
    const storage = createAgentAccessBlobStorage();
    const existing = await readBrandBook(storage, id);
    if (existing === null) return notFoundResponse('Brand book');

    const now = new Date().toISOString();
    const book = await settleBrandBookFiles(session, id, parsed.book);
    const record: AdminBrandBook = {
      version: 1,
      id,
      book,
      createdBy: existing.record.createdBy,
      createdAt: existing.record.createdAt,
      updatedBy: userMail,
      updatedAt: now,
    };
    const etag = await writeBrandBook(storage, record, ifMatchEtag);
    service.invalidate();
    auditAdminWrite('brand-book-upsert', canonicalKey, userMail);
    await tidyFilesBestEffort(id, book);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof BrandFileError) {
      return badRequestResponse(error.message);
    }
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update brand book');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id || !BRAND_BOOK_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid brand book id');
  }
  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }
  const canonicalKey = canonicalAgentKey(BRAND_BOOK_SOURCE, id);

  try {
    const admin = await adminOf(service);
    if ('refused' in admin) return admin.refused;
    const { userMail, status } = admin;
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this brand book');
    }
    const deleted = await deleteBrandBook(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!deleted) return notFoundResponse('Brand book');
    await tidyFilesBestEffort(id, null);
    service.invalidate();
    auditAdminWrite('brand-book-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      record: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });
    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete brand book');
  }
}
