import { NextRequest } from 'next/server';

import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { mergeGlossaryEntries } from '@/lib/services/workflows/shared/glossaryPrompts';
import {
  requestedGuideIds,
  resolveOrgGlossaries,
} from '@/lib/services/workflows/shared/orgGlossaries';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';
import { runTranslationChangeRequest } from '@/lib/services/workflows/translation/translationOrchestrator';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  MAX_GUIDE_ENTRIES,
  MAX_ORG_GLOSSARIES_PER_REQUEST,
} from '@/lib/utils/shared/review/guideCriteria';
import {
  ChangeSelection,
  MAX_CHANGE_INSTRUCTION_CHARS,
  isValidSelection,
} from '@/lib/utils/shared/translation/changeRequest';
import { sanitizeGlossaryEntry } from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_TEXT_CHARS = 60_000;
const MAX_LANGUAGE_LABEL_CHARS = 80;
/** A locale code is placed in the prompt, so only that shape is accepted. */
const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
/** Same ceiling as the translate and assess routes. */
const MAX_GLOSSARY_ENTRIES =
  MAX_ORG_GLOSSARIES_PER_REQUEST * MAX_GUIDE_ENTRIES + MAX_GUIDE_ENTRIES;

interface TranslationReviseRequest {
  /** Optional: a scanned page has a translation but no source text. */
  sourceText?: string;
  translation: string;
  targetLanguage: string;
  /** The change the user asked for, in their own words. */
  instruction: string;
  /** Limits the edits to one passage of the translation. */
  selection?: ChangeSelection;
  /** The user's UI locale (e.g. "en", "pt-BR"), for the reply language. */
  interfaceLocale?: string;
  glossaryEntries?: GlossaryEntry[];
  glossaryGuideIds?: string[];
  /** Legacy single-guide form of `glossaryGuideIds`. */
  glossaryGuideId?: string;
  modelId?: string;
  /** Correlates the run's calls in telemetry; not otherwise used. */
  conversationId?: string;
}

/**
 * POST /api/workflows/translation/revise: a change to a translation asked
 * for in words, returned as individual edits the client reviews as
 * accept/reject diffs. Nothing is applied server-side. A message that is a
 * question comes back as a reply with no edits.
 *
 * Responds 400 for a missing or oversized field or a selection that is not
 * a passage of the translation, 401 without a session, and the workflow
 * policy / token budget refusals shared by every workflow route.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('translation'))) {
    return workflowDisabledResponse('translation');
  }

  // Must precede resolveOrgGlossaries: group-scoped access rules read the
  // membership cache synchronously. Never throws.
  await resolveUserGroupIds(req, session);

  let body: TranslationReviseRequest;
  try {
    body = (await req.json()) as TranslationReviseRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const sourceText = typeof body.sourceText === 'string' ? body.sourceText : '';
  const translation =
    typeof body.translation === 'string' ? body.translation : '';
  const targetLanguage = body.targetLanguage?.trim();
  const instruction =
    typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!translation.trim()) return badRequestResponse('Translation is required');
  if (!targetLanguage) return badRequestResponse('Target language is required');
  if (!instruction) return badRequestResponse('Instruction is required');
  if (
    sourceText.length > MAX_TEXT_CHARS ||
    translation.length > MAX_TEXT_CHARS
  ) {
    return badRequestResponse('Text is too long');
  }
  if (targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return badRequestResponse('Target language name is too long');
  }
  if (instruction.length > MAX_CHANGE_INSTRUCTION_CHARS) {
    return badRequestResponse('Instruction is too long');
  }
  let selection: ChangeSelection | undefined;
  if (body.selection !== undefined && body.selection !== null) {
    if (!isValidSelection(translation, body.selection)) {
      return badRequestResponse('Selection is not part of the translation');
    }
    selection = { text: body.selection.text, start: body.selection.start };
  }

  // Same guard and merge as the assess route: entries become prompt text.
  const localEntries: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries
        .map((entry: unknown) => sanitizeGlossaryEntry(entry))
        .filter((entry): entry is GlossaryEntry => entry !== null)
        .slice(0, MAX_GUIDE_ENTRIES)
    : [];
  const guideIds = requestedGuideIds(body);
  if (guideIds === null) {
    return badRequestResponse(
      `At most ${MAX_ORG_GLOSSARIES_PER_REQUEST} organization glossaries per run`,
    );
  }
  const orgResolution = await resolveOrgGlossaries(
    session.user?.mail ?? undefined,
    guideIds,
  );
  if ('error' in orgResolution) {
    return badRequestResponse(orgResolution.error);
  }
  const glossaryEntries = mergeGlossaryEntries(
    orgResolution.entries,
    localEntries,
  ).slice(0, MAX_GLOSSARY_ENTRIES);

  const { denied, usage } = await beginWorkflowRun(
    session,
    'revise',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const result = await runTranslationChangeRequest({
      sourceText,
      // Exactly as sent: edits must match the client's working text.
      translation,
      targetLanguage,
      instruction,
      selection,
      // Anything that is not a plain locale code is ignored, not refused.
      interfaceLocale:
        typeof body.interfaceLocale === 'string' &&
        LOCALE_PATTERN.test(body.interfaceLocale)
          ? body.interfaceLocale
          : undefined,
      glossaryEntries,
      modelId: resolveWorkflowModelId(body.modelId),
      usage,
    });
    return successResponse({ ...result, ...usage.fields() });
  } catch (error) {
    console.error('[workflows/translation/revise] Failed:', error);
    return handleApiError(error, 'Change request failed');
  }
}
