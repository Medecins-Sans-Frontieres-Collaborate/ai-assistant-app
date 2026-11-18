import { NextRequest } from 'next/server';

import { resolveRequestGlossary } from '@/lib/services/documentTranslation/native/nativePdfGlossary';
import { reviseNativeUnit } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import {
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  MAX_STEP_INSTRUCTION_CHARS,
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_TRANSLATION_CHARS,
  NATIVE_PDF_UNIT_ACTIONS,
  NativePdfUnitAction,
} from '@/lib/utils/shared/translation/nativePdf';

import { auth } from '@/auth';

export const maxDuration = 120;

const MAX_LANGUAGE_LABEL_CHARS = 80;

interface UnitRequest {
  action?: unknown;
  targetLanguage?: unknown;
  source?: unknown;
  translation?: unknown;
  instruction?: unknown;
  targetChars?: unknown;
  glossaryEntries?: unknown;
  glossaryGuideIds?: unknown;
  modelId?: string;
  conversationId?: unknown;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * POST /api/document-translation/native/unit — rewrites the translation of
 * one text block of a native PDF run. Nothing is laid out; the caller
 * re-renders (POST .../native/render) when ready.
 *
 * JSON body: `action` ("shorten", "change" or "translate"),
 * `targetLanguage`, `source`, `translation` (not needed for "translate"),
 * `instruction` (for "change"), `targetChars` (visible length to aim for),
 * optional glossaries, `modelId`, `conversationId`.
 *
 * Returns `{ text, repaired }`: the new translation and whether its inline
 * tags had to be repaired against the source.
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

  let body: UnitRequest;
  try {
    body = (await req.json()) as UnitRequest;
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  const action = body.action as NativePdfUnitAction;
  if (!NATIVE_PDF_UNIT_ACTIONS.includes(action)) {
    return badRequestResponse(
      `action must be one of: ${NATIVE_PDF_UNIT_ACTIONS.join(', ')}`,
    );
  }
  const targetLanguage = text(body.targetLanguage);
  if (!targetLanguage || targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return badRequestResponse('A target language is required');
  }
  const source = text(body.source);
  const translation = text(body.translation);
  const instruction = text(body.instruction);
  if (!source) return badRequestResponse('The source text is required');
  if (action !== 'translate' && !translation) {
    return badRequestResponse('The current translation is required');
  }
  if (action === 'change' && !instruction) {
    return badRequestResponse('Say what to change');
  }
  if (
    source.length > NATIVE_PDF_MAX_TRANSLATION_CHARS ||
    translation.length > NATIVE_PDF_MAX_TRANSLATION_CHARS ||
    instruction.length > MAX_STEP_INSTRUCTION_CHARS
  ) {
    return badRequestResponse('The text is too long for one block');
  }
  const targetChars = Number(body.targetChars);
  if (!Number.isFinite(targetChars) || targetChars < 1) {
    return badRequestResponse('targetChars must be a positive number');
  }

  const glossary = await resolveRequestGlossary(req, session, body);
  if ('error' in glossary) return badRequestResponse(glossary.error);

  const { denied, usage } = await beginWorkflowRun(
    session,
    'native-pdf-unit',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const revised = await reviseNativeUnit({
      action,
      targetLanguage,
      source,
      translation,
      instruction,
      targetChars: Math.floor(targetChars),
      glossaryEntries: glossary.entries,
      modelId: resolveWorkflowModelId(body.modelId),
      usage,
    });
    return successResponse({ ...revised, ...usage.fields() });
  } catch (error) {
    console.error('[document-translation/native/unit] Failed:', error);
    return handleApiError(error, 'Changing the block failed');
  }
}
