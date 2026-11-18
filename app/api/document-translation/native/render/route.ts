import { NextRequest } from 'next/server';

import {
  NativePdfDocumentLimitError,
  NativePdfNoPagesLeftError,
  rerenderNativePdf,
} from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import {
  isNativeFileId,
  readNativeFile,
  storeNativeFile,
  storeNativeRebuild,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import {
  getWorkflowFeatureLimits,
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import {
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_CHECK_PAGES,
  NATIVE_PDF_MAX_EXTRACTIONS,
  NATIVE_PDF_MAX_OMITTED_PAGES,
  NATIVE_PDF_MAX_PAGES,
  NATIVE_PDF_MAX_UNITS,
  nativePdfLimits,
  sanitizeStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

import { auth } from '@/auth';

export const maxDuration = 300;

interface RenderRequest {
  /** `sourceId` returned by the run being edited. */
  sourceId?: unknown;
  /** `unitsId` returned by the run being edited. */
  unitsId?: unknown;
  /**
   * Instead of `unitsId`: the extractions of several batches of the same
   * document, oldest first, to put together into one result.
   */
  unitsIds?: unknown;
  /** Unit id to translation; null or absent keeps the unit as written. */
  translations?: unknown;
  /** Pages to run the layout check on afterwards. */
  checkPages?: unknown;
  /** Pages to return images of; absent means every translated page. */
  imagePages?: unknown;
  /** Source pages to leave out of the PDF. */
  omitPages?: unknown;
  instructions?: unknown;
  modelId?: string;
  conversationId?: unknown;
}

/** A short list of distinct page numbers, or null when the value is not one. */
function parsePageList(value: unknown, max: number): number[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const valid = value.every((page) => Number.isInteger(page) && page >= 1);
  return valid ? [...new Set(value as number[])] : null;
}

/** The extraction ids of a request, or null when they are missing or invalid. */
function parseUnitsIds(body: RenderRequest): string[] | null {
  const ids = body.unitsIds === undefined ? [body.unitsId] : body.unitsIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > NATIVE_PDF_MAX_EXTRACTIONS
  ) {
    return null;
  }
  return ids.every((id) => isNativeFileId(id, 'json'))
    ? [...new Set(ids as string[])]
    : null;
}

/**
 * POST /api/document-translation/native/render — lays a native PDF run's
 * pages out again with edited translations. Runs the rebuild step only,
 * plus the layout check on `checkPages`; nothing is re-extracted or
 * re-translated.
 *
 * JSON body: `sourceId` and `unitsId` from the run, `translations` (every
 * unit that should be translated, by id), optional `checkPages`,
 * `imagePages`, `omitPages` (source pages to leave out of the PDF; 400
 * `NO_PAGES_LEFT` when that is every page), `instructions` (only `verify` applies), `modelId`,
 * `conversationId`.
 *
 * This is also how batches of one document become one file: send
 * `unitsIds` (each batch's `unitsId`, oldest first) instead of `unitsId`,
 * with the translations of all of them. The answer's `unitsId` then names
 * a new extraction holding every batch, to send alone from then on.
 *
 * Returns the new `pdfUrl` (the whole document, translated pages replaced),
 * `pageImages` for the pages asked for, each unit's fit, the findings for
 * the checked pages, and the ids of units whose tags were repaired or whose
 * text was refused as too long. Refused with 400 `DOCUMENT_PAGE_LIMIT` when
 * more pages would be translated than the person's document limit.
 *
 * Refused (403) while an admin has the Preserve formatting feature or the
 * translation workflow switched off (Admin > Workflows).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowFeatureEnabled(NATIVE_PDF_FEATURE))) {
    return workflowFeatureDisabledResponse(NATIVE_PDF_FEATURE);
  }

  let body: RenderRequest;
  try {
    body = (await req.json()) as RenderRequest;
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  const { sourceId, translations } = body;
  const unitsIds = parseUnitsIds(body);
  if (!isNativeFileId(sourceId, 'pdf') || !unitsIds) {
    return badRequestResponse('sourceId and unitsId from a run are required');
  }
  if (
    !translations ||
    typeof translations !== 'object' ||
    Array.isArray(translations)
  ) {
    return badRequestResponse('translations must be an object keyed by unit');
  }
  const limits = nativePdfLimits(
    await getWorkflowFeatureLimits(NATIVE_PDF_FEATURE, session),
  );
  // A run holds NATIVE_PDF_MAX_UNITS at most, and a document one run per
  // request of each batch; the page limit itself is checked on the units.
  const maxUnits =
    NATIVE_PDF_MAX_UNITS *
    Math.ceil(limits.maxDocumentPages / NATIVE_PDF_MAX_PAGES);
  if (Object.keys(translations).length > maxUnits) {
    return badRequestResponse(
      `At most ${maxUnits} units can be laid out in one request`,
    );
  }
  const checkPages = parsePageList(
    body.checkPages ?? [],
    NATIVE_PDF_MAX_CHECK_PAGES,
  );
  if (!checkPages) {
    return badRequestResponse(
      `checkPages must list at most ${NATIVE_PDF_MAX_CHECK_PAGES} page numbers`,
    );
  }
  const imagePages =
    body.imagePages === undefined
      ? undefined
      : parsePageList(body.imagePages, limits.maxDocumentPages);
  if (imagePages === null) {
    return badRequestResponse('imagePages must be a list of page numbers');
  }
  const omitPages = parsePageList(
    body.omitPages ?? [],
    NATIVE_PDF_MAX_OMITTED_PAGES,
  );
  if (!omitPages) {
    return badRequestResponse('omitPages must be a list of page numbers');
  }

  let document: Buffer;
  let unitsFiles: Buffer[];
  try {
    [document, ...unitsFiles] = await Promise.all([
      readNativeFile(session, sourceId, 'pdf'),
      ...unitsIds.map((id) => readNativeFile(session, id, 'json')),
    ]);
  } catch (error) {
    if (isBlobNotFoundError(error)) {
      return notFoundResponse('The files of this translation run');
    }
    console.error('[document-translation/native/render] Read failed:', error);
    return handleApiError(error, 'Could not read the translation run');
  }

  const { denied, usage } = await beginWorkflowRun(
    session,
    'native-pdf-render',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const { pdf, outputs, unitsFile, ...report } = await rerenderNativePdf({
      document,
      unitsFiles,
      translations,
      checkPages,
      imagePages,
      omitPages,
      maxDocumentPages: limits.maxDocumentPages,
      instructions: sanitizeStepInstructions(body.instructions),
      modelId: resolveWorkflowModelId(body.modelId),
      usage,
    });
    // Several extractions were combined: the combination is stored so the
    // next re-render sends one id. A single one is already stored.
    const unitsId =
      unitsIds.length === 1
        ? unitsIds[0]
        : (await storeNativeFile(session, unitsFile, 'json')).id;
    return successResponse({
      ...report,
      unitsId,
      ...(await storeNativeRebuild(session, { pdf, outputs })),
      ...usage.fields(),
    });
  } catch (error) {
    if (error instanceof NativePdfDocumentLimitError) {
      return errorResponse(
        error.message,
        400,
        undefined,
        'DOCUMENT_PAGE_LIMIT',
      );
    }
    if (error instanceof NativePdfNoPagesLeftError) {
      return errorResponse(error.message, 400, undefined, 'NO_PAGES_LEFT');
    }
    console.error('[document-translation/native/render] Failed:', error);
    return handleApiError(error, 'Re-rendering the pages failed');
  }
}
