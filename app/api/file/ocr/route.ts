import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import {
  DocumentIntelligenceError,
  isDocumentIntelligenceConfigured,
} from '@/lib/services/documentIntelligence/client';
import { ocrPdfToPagedText } from '@/lib/services/documentIntelligence/ocrText';
import { guardLimit } from '@/lib/services/limits/routeGuard';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isBlobUrlOwnedByUser } from '@/lib/utils/server/file/blobOwnership';
import { countPdfPages } from '@/lib/utils/server/file/fileHandling';
import { isValidFileId } from '@/lib/utils/server/file/fileId';
import { getCachedTextPath } from '@/lib/utils/server/file/textCacheUtils';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  MAX_OCR_PAGES,
  OCR_ERROR,
  OCR_PAGES_LIMIT_KEY,
  supportsOcr,
} from '@/lib/utils/shared/file/ocr';

import { auth } from '@/auth';

// OCR of a long document takes minutes; the client shows progress and can
// cancel, which aborts the analysis through the request signal.
export const maxDuration = 300;

/**
 * Reads an uploaded PDF with OCR.
 *
 * Body: `{ url }`, the blob reference returned by `/api/file/upload`.
 *
 * The pages are charged against the caller's daily OCR allowance
 * (`feature.ocr.pagesPerDay`) before the analysis and refunded if it
 * produces nothing. The text is written to the
 * file's text cache, so `/api/file/process` returns the OCR text for this
 * file from then on (for example when its pages are re-read after a reload).
 *
 * Responds with `{ content, pageCount }`, `content` in the paged format of
 * the PDF extractors. Errors carry a code from `OCR_ERROR`; an exhausted
 * allowance is the limit guard's 429.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();

  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const url = typeof body?.url === 'string' ? body.url : '';
  const fileId = url.split('/').pop() ?? '';
  if (!url || !isValidFileId(fileId)) {
    return badRequestResponse('"url" must reference an uploaded file');
  }
  const userId = getUserIdFromSession(session);
  if (!isBlobUrlOwnedByUser(url, userId)) {
    return forbiddenResponse(
      'Forbidden: blob does not belong to the authenticated user',
    );
  }
  if (!supportsOcr(fileId)) {
    return errorResponse(
      'OCR is available for PDF files only',
      400,
      undefined,
      OCR_ERROR.unsupportedFormat,
    );
  }
  if (!isDocumentIntelligenceConfigured()) {
    return errorResponse(
      'OCR is not configured on this server',
      503,
      undefined,
      OCR_ERROR.notConfigured,
    );
  }

  const blobStorage = createBlobStorageClient(session);
  const blobPath = `${userId}/uploads/files/${fileId}`;
  let pdf: Buffer;
  try {
    pdf = (await blobStorage.get(blobPath, BlobProperty.BLOB)) as Buffer;
  } catch (error) {
    if (isBlobNotFoundError(error)) {
      return errorResponse('File not found', 404, undefined, 'FILE_NOT_FOUND');
    }
    console.error('[api/file/ocr] Could not read file:', sanitizeForLog(error));
    return errorResponse(
      'Could not read the file',
      500,
      undefined,
      OCR_ERROR.failed,
    );
  }

  let pageCount: number;
  try {
    pageCount = await countPdfPages(pdf, { signal: request.signal });
  } catch (error) {
    // Unlike translation, OCR does not fail open here: an uncounted file
    // would be analysed, and billed, without bound.
    console.warn(
      '[api/file/ocr] Could not count pages:',
      sanitizeForLog(error),
    );
    return errorResponse(
      'The PDF could not be read',
      422,
      undefined,
      OCR_ERROR.failed,
    );
  }
  if (pageCount > MAX_OCR_PAGES) {
    return errorResponse(
      `The document has ${pageCount} pages; OCR reads at most ${MAX_OCR_PAGES}`,
      413,
      { pageCount, maxPages: MAX_OCR_PAGES },
      OCR_ERROR.tooManyPages,
    );
  }

  const guard = await guardLimit(session, OCR_PAGES_LIMIT_KEY, {
    req: request,
    amount: pageCount,
  });
  if (!guard.allowed) {
    return (
      guard.response ??
      errorResponse('OCR page limit reached', 429, undefined, 'LIMIT_REACHED')
    );
  }

  try {
    const { text } = await ocrPdfToPagedText(pdf, request.signal);
    if (!text) {
      await guard.rollback?.();
      return errorResponse(
        'OCR found no text in the document',
        422,
        undefined,
        OCR_ERROR.noText,
      );
    }
    try {
      await blobStorage.upload(getCachedTextPath(blobPath), text, {
        blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
      });
    } catch (error) {
      // The text is still returned; only later re-reads lose it.
      console.warn(
        '[api/file/ocr] Could not cache OCR text:',
        sanitizeForLog(error),
      );
    }
    return successResponse({ content: text, pageCount });
  } catch (error) {
    await guard.rollback?.();
    const aborted =
      error instanceof DocumentIntelligenceError && error.kind === 'aborted';
    if (!aborted) {
      console.error('[api/file/ocr] OCR failed:', sanitizeForLog(error));
    }
    return errorResponse(
      aborted ? 'OCR was cancelled' : 'OCR failed',
      aborted ? 499 : 502,
      undefined,
      OCR_ERROR.failed,
    );
  }
}
