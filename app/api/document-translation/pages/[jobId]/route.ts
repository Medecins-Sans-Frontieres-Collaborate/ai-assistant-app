/**
 * Page-level text of a translated document.
 *
 * GET /api/document-translation/pages/{jobId}?from=1&to=10
 *   Returns the source text, the machine translation and the user's
 *   correction (if any) for a window of pages, plus which pages have
 *   corrections. The text lives in blob storage; the client holds only the
 *   window it is showing.
 *
 * PUT /api/document-translation/pages/{jobId}
 *   Body: { page: number, text: string | null }
 *   Saves the user's corrected text for one page; `null` removes the
 *   correction. Corrections are delivered by the DOCX export, not by the
 *   layout-preserving translated file.
 */
import { NextRequest } from 'next/server';

import { resolveOwnedTranslationJob } from '@/lib/services/documentTranslation/translationJobAccess';
import {
  InvalidCorrectionError,
  MAX_PAGES_PER_READ,
  PagedTextUnsupportedError,
  TranslationFilesMissingError,
  correctedPageNumbers,
  getPageCorrections,
  getTranslationPages,
  savePageCorrection,
} from '@/lib/services/documentTranslation/translationPages';

import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

/** First use extracts the text of both files; allow for a long document. */
export const maxDuration = 120;

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/** Maps the page service's typed failures to responses; rethrows the rest. */
function pageErrorResponse(error: unknown) {
  if (error instanceof PagedTextUnsupportedError) {
    return errorResponse(error.message, 422, undefined, 'PAGES_UNSUPPORTED');
  }
  if (error instanceof TranslationFilesMissingError) {
    return errorResponse(error.message, 404, undefined, 'TRANSLATION_MISSING');
  }
  if (error instanceof InvalidCorrectionError) {
    return badRequestResponse(error.message, 'INVALID_CORRECTION');
  }
  console.error(
    '[DocumentTranslation] Page text request failed:',
    error instanceof Error ? error.message : error,
  );
  return errorResponse(
    'Failed to read the translated pages',
    500,
    undefined,
    'PAGES_FAILED',
  );
}

function parsePageNumber(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { jobId } = await params;
  const owned = await resolveOwnedTranslationJob(jobId);
  if (!owned.ok) return owned.response;

  const search = request.nextUrl.searchParams;
  const from = parsePageNumber(search.get('from')) ?? 1;
  const requestedTo = parsePageNumber(search.get('to')) ?? from;
  if (from < 1 || requestedTo < from) {
    return badRequestResponse(
      '"from" and "to" must be page numbers with from <= to',
      'INVALID_PAGE_RANGE',
    );
  }

  try {
    const [record, corrections] = await Promise.all([
      getTranslationPages(owned.storage, owned.job, { signal: request.signal }),
      getPageCorrections(owned.storage, owned.job),
    ]);
    // Clamp instead of rejecting: a client paging forward asks for the next
    // window without knowing where the document ends.
    const to = Math.min(
      requestedTo,
      from + MAX_PAGES_PER_READ - 1,
      record.pageCount,
    );
    return successResponse({
      jobId: record.jobId,
      pageCount: record.pageCount,
      pagesAligned: record.pagesAligned,
      from,
      to,
      pages: record.pages.slice(from - 1, to).map((page) => ({
        ...page,
        ...(corrections.has(page.page) && {
          correction: corrections.get(page.page),
        }),
      })),
      correctedPages: correctedPageNumbers(corrections),
    });
  } catch (error) {
    return pageErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { jobId } = await params;
  const owned = await resolveOwnedTranslationJob(jobId);
  if (!owned.ok) return owned.response;

  let body: { page?: unknown; text?: unknown };
  try {
    body = (await request.json()) as { page?: unknown; text?: unknown };
  } catch {
    return badRequestResponse('Invalid JSON body', 'INVALID_JSON');
  }
  if (typeof body.page !== 'number') {
    return badRequestResponse('"page" must be a number', 'INVALID_CORRECTION');
  }
  if (body.text !== null && typeof body.text !== 'string') {
    return badRequestResponse(
      '"text" must be a string, or null to remove the correction',
      'INVALID_CORRECTION',
    );
  }

  try {
    const record = await getTranslationPages(owned.storage, owned.job, {
      signal: request.signal,
    });
    const corrections = await savePageCorrection(
      owned.storage,
      owned.job,
      body.page,
      body.text,
      record.pageCount,
    );
    return successResponse({
      page: body.page,
      correction: corrections.get(body.page) ?? null,
      correctedPages: correctedPageNumbers(corrections),
    });
  } catch (error) {
    return pageErrorResponse(error);
  }
}
