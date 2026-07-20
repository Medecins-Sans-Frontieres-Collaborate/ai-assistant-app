import { NextRequest } from 'next/server';

import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { runTranslationAssessment } from '@/lib/services/workflows/translation/translationOrchestrator';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  CustomCriterionDefinition,
  collectCustomCriteria,
  isCustomCriterionId,
} from '@/lib/utils/shared/review/customCriteria';
import { isTranslationBuiltinCriterionId } from '@/lib/utils/shared/translation/qualityCriteria';

import { GlossaryEntry } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_TEXT_CHARS = 60_000;
const MAX_LANGUAGE_LABEL_CHARS = 80;
const MAX_GLOSSARY_ENTRIES = 500;
const MAX_CRITERIA = 24;

interface TranslationAssessRequest {
  sourceText: string;
  translation: string;
  targetLanguage: string;
  criteria: string[];
  customCriteria?: CustomCriterionDefinition[];
  glossaryEntries?: GlossaryEntry[];
  modelId?: string;
}

/**
 * POST /api/workflows/translation/assess — MQM-derived quality assessment
 * of a translation (generated or user-provided): per-criterion 1–5
 * ratings plus granular proposed edits the client reviews as
 * accept/reject diffs. Synchronous JSON, one strict structured call.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: TranslationAssessRequest;
  try {
    body = (await req.json()) as TranslationAssessRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const sourceText = body.sourceText?.trim();
  const translation = body.translation?.trim();
  const targetLanguage = body.targetLanguage?.trim();
  if (!sourceText) return badRequestResponse('Source text is required');
  if (!translation) return badRequestResponse('Translation is required');
  if (!targetLanguage) return badRequestResponse('Target language is required');
  if (
    sourceText.length > MAX_TEXT_CHARS ||
    translation.length > MAX_TEXT_CHARS
  ) {
    return badRequestResponse('Text is too long');
  }
  if (targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return badRequestResponse('Target language name is too long');
  }
  if (!Array.isArray(body.criteria) || body.criteria.length === 0) {
    return badRequestResponse('At least one criterion is required');
  }
  const criterionIds = [...new Set(body.criteria)];
  if (criterionIds.length > MAX_CRITERIA) {
    return badRequestResponse('Too many criteria');
  }

  // Two-phase: keep only well-formed custom definitions, then require every
  // requested custom id to have one. A criterion with no usable rubric is
  // rejected rather than reaching the model as a blank line.
  const customById = collectCustomCriteria(body.customCriteria);
  for (const id of criterionIds) {
    if (isTranslationBuiltinCriterionId(id)) continue;
    if (isCustomCriterionId(id) && customById.has(id)) continue;
    return badRequestResponse('Unknown criterion');
  }

  const glossaryEntries: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries
        .filter(
          (e): e is GlossaryEntry =>
            !!e && typeof e.source === 'string' && typeof e.target === 'string',
        )
        .slice(0, MAX_GLOSSARY_ENTRIES)
    : [];

  try {
    const result = await runTranslationAssessment({
      sourceText,
      // Assess the translation exactly as sent — edits must match the
      // client's working text, so no trimming beyond the emptiness check.
      translation: body.translation,
      targetLanguage,
      criterionIds,
      customById,
      glossaryEntries,
      modelId: resolveWorkflowModelId(body.modelId),
    });

    return successResponse(result);
  } catch (error) {
    console.error('[workflows/translation/assess] Failed:', error);
    return handleApiError(error, 'Assessment failed');
  }
}
