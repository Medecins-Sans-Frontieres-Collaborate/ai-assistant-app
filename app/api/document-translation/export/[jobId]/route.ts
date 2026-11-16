/**
 * Text version of a translated document.
 *
 * GET /api/document-translation/export/{jobId}?format=docx
 *
 * Returns the translation as a Word file with the user's page corrections
 * applied, one DOCX page per source page. This is the editable companion to
 * the layout-preserving translated file, which is served unchanged by
 * /api/document-translation/content/{jobId}.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  DOCX_CONTENT_TYPE,
  renderTranslationDocx,
} from '@/lib/services/documentTranslation/translationDocx';
import { resolveOwnedTranslationJob } from '@/lib/services/documentTranslation/translationJobAccess';
import {
  PagedTextUnsupportedError,
  TranslationFilesMissingError,
  effectiveTranslation,
  getPageCorrections,
  getTranslationPages,
} from '@/lib/services/documentTranslation/translationPages';

import { getLanguageDirection } from '@/lib/utils/app/rtl';
import {
  badRequestResponse,
  errorResponse,
} from '@/lib/utils/server/api/apiResponse';

import { textVersionFilename } from '@/types/documentTranslation';

/** Extraction on first use plus the DOCX render of a long document. */
export const maxDuration = 120;

/** Export formats this route can produce. */
const EXPORT_FORMATS: ReadonlySet<string> = new Set(['docx']);

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { jobId } = await params;
  const owned = await resolveOwnedTranslationJob(jobId);
  if (!owned.ok) return owned.response;

  const format = request.nextUrl.searchParams.get('format') ?? 'docx';
  if (!EXPORT_FORMATS.has(format)) {
    return badRequestResponse(
      `Unsupported export format "${format}". Supported: ${[...EXPORT_FORMATS].join(', ')}`,
      'UNSUPPORTED_EXPORT_FORMAT',
    );
  }

  try {
    const [record, corrections] = await Promise.all([
      getTranslationPages(owned.storage, owned.job, { signal: request.signal }),
      getPageCorrections(owned.storage, owned.job),
    ]);
    const filename = textVersionFilename(owned.job.translatedFilename);
    const docx = await renderTranslationDocx(
      record.pages.map((page) => ({
        page: page.page,
        text: effectiveTranslation(page, corrections),
      })),
      {
        title: filename,
        language: owned.job.targetLanguage,
        direction: getLanguageDirection(owned.job.targetLanguage),
        signal: request.signal,
      },
    );
    return new NextResponse(new Uint8Array(docx), {
      status: 200,
      headers: {
        'Content-Type': DOCX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': docx.length.toString(),
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    if (error instanceof PagedTextUnsupportedError) {
      return errorResponse(error.message, 422, undefined, 'PAGES_UNSUPPORTED');
    }
    if (error instanceof TranslationFilesMissingError) {
      return errorResponse(
        error.message,
        404,
        undefined,
        'TRANSLATION_MISSING',
      );
    }
    console.error(
      '[DocumentTranslation] Text version export failed:',
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      'Failed to build the text version',
      500,
      undefined,
      'EXPORT_FAILED',
    );
  }
}
