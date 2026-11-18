import { NextRequest } from 'next/server';

import { rerenderNativePdf } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import {
  isNativeFileId,
  readNativeFile,
  storeNativeRebuild,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import {
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import {
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_PAGES,
  NATIVE_PDF_MAX_UNITS,
  sanitizeStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

import { auth } from '@/auth';

export const maxDuration = 300;

interface RenderRequest {
  /** `sourceId` returned by the run being edited. */
  sourceId?: unknown;
  /** `unitsId` returned by the run being edited. */
  unitsId?: unknown;
  /** Unit id to translation; null or absent keeps the unit as written. */
  translations?: unknown;
  /** Pages to run the layout check on afterwards. */
  checkPages?: unknown;
  instructions?: unknown;
  modelId?: string;
  conversationId?: unknown;
}

/** The pages to check, or null when the value is not a short list of page numbers. */
function parseCheckPages(value: unknown): number[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NATIVE_PDF_MAX_PAGES) return null;
  const valid = value.every((page) => Number.isInteger(page) && page >= 1);
  return valid ? [...new Set(value as number[])] : null;
}

/**
 * POST /api/document-translation/native/render — lays a native PDF run's
 * pages out again with edited translations. Runs the rebuild step only,
 * plus the layout check on `checkPages`; nothing is re-extracted or
 * re-translated.
 *
 * JSON body: `sourceId` and `unitsId` from the run, `translations` (every
 * unit that should be translated, by id), optional `checkPages`,
 * `instructions` (only `verify` applies), `modelId`, `conversationId`.
 *
 * Returns the new `pdfUrl` and `pageImages`, each unit's fit, the findings
 * for the checked pages, and the ids of units whose tags were repaired or
 * whose text was refused as too long.
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
  const { sourceId, unitsId, translations } = body;
  if (!isNativeFileId(sourceId, 'pdf') || !isNativeFileId(unitsId, 'json')) {
    return badRequestResponse('sourceId and unitsId from a run are required');
  }
  if (
    !translations ||
    typeof translations !== 'object' ||
    Array.isArray(translations)
  ) {
    return badRequestResponse('translations must be an object keyed by unit');
  }
  if (Object.keys(translations).length > NATIVE_PDF_MAX_UNITS) {
    return badRequestResponse(
      `At most ${NATIVE_PDF_MAX_UNITS} units can be laid out in one request`,
    );
  }
  const checkPages = parseCheckPages(body.checkPages);
  if (!checkPages) {
    return badRequestResponse(
      `checkPages must list at most ${NATIVE_PDF_MAX_PAGES} page numbers`,
    );
  }

  let document: Buffer;
  let unitsFile: Buffer;
  try {
    [document, unitsFile] = await Promise.all([
      readNativeFile(session, sourceId, 'pdf'),
      readNativeFile(session, unitsId, 'json'),
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
    const { pdf, outputs, ...report } = await rerenderNativePdf({
      document,
      unitsFile,
      translations,
      checkPages,
      instructions: sanitizeStepInstructions(body.instructions),
      modelId: resolveWorkflowModelId(body.modelId),
      usage,
    });
    return successResponse({
      ...report,
      ...(await storeNativeRebuild(session, { pdf, outputs })),
      ...usage.fields(),
    });
  } catch (error) {
    console.error('[document-translation/native/render] Failed:', error);
    return handleApiError(error, 'Re-rendering the pages failed');
  }
}
