import { NextRequest } from 'next/server';

import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { mergeGlossaryEntries } from '@/lib/services/workflows/shared/glossaryPrompts';
import { resolveSlotGuide } from '@/lib/services/workflows/shared/guideResolution';
import { createWorkflowStream } from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { runTranslationWorkflow } from '@/lib/services/workflows/translation/translationOrchestrator';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { GlossaryEntry } from '@/types/workflow';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

/** Client also pre-checks; server is authoritative. */
const MAX_SOURCE_CHARS = 60_000;
const MAX_GLOSSARY_ENTRIES = 500;

const MAX_LANGUAGE_LABEL_CHARS = 80;

interface TranslationWorkflowRequest {
  sourceText: string;
  /**
   * Display label of the target language (e.g. "Pashto (پښتو)" or a
   * user-added name). Free text by design — the catalog and custom
   * languages both resolve to labels client-side.
   */
  targetLanguage: string;
  glossaryEntries?: GlossaryEntry[];
  /** Admin terminology guide whose entries merge with (and win over) the
   * local glossary. Resolved server-side by id, fail-closed. */
  glossaryGuideId?: string;
  mode: 'quick' | 'agentic';
  maxReviewRounds?: number;
  modelId?: string;
}

/**
 * POST /api/workflows/translation — streams the translation as display
 * text plus structured WORKFLOW_EVENTs (analysis, review rounds,
 * revisions, complete). Glossaries travel inline; the server is stateless.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  // Admin workflow policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md): a workflow an
  // admin switched off is refused server-side, not just hidden.
  if (!(await isWorkflowEnabled('translation'))) {
    return workflowDisabledResponse('translation');
  }

  // Group-membership warm-up MUST precede resolveSlotGuide below — guide
  // access rules with group scope read the cache synchronously. Never throws.
  await resolveUserGroupIds(req, session);

  let body: TranslationWorkflowRequest;
  try {
    body = (await req.json()) as TranslationWorkflowRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const sourceText = body.sourceText?.trim();
  if (!sourceText) return badRequestResponse('Source text is required');
  if (sourceText.length > MAX_SOURCE_CHARS) {
    return badRequestResponse(
      `Source text is too long (max ${MAX_SOURCE_CHARS} characters)`,
    );
  }
  const targetLanguage = body.targetLanguage?.trim();
  if (!targetLanguage) {
    return badRequestResponse('Target language is required');
  }
  if (targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return badRequestResponse('Target language name is too long');
  }
  if (body.mode !== 'quick' && body.mode !== 'agentic') {
    return badRequestResponse('mode must be "quick" or "agentic"');
  }

  const localEntries: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries.filter(
        (e): e is GlossaryEntry =>
          !!e && typeof e.source === 'string' && typeof e.target === 'string',
      )
    : [];

  // Admin terminology guide: resolved fail-closed BEFORE the stream opens so
  // a stale/revoked reference is a clean 400. Guide entries come first and
  // win on duplicate source terms — org terminology is authoritative.
  let guideEntries: GlossaryEntry[] = [];
  if (typeof body.glossaryGuideId === 'string' && body.glossaryGuideId) {
    const resolved = await resolveSlotGuide({
      userMail: session.user?.mail ?? undefined,
      guideId: body.glossaryGuideId,
      expectedKind: 'terminology',
      workflow: 'translation',
    });
    if ('error' in resolved) return badRequestResponse(resolved.error);
    if (resolved.guide.payload.kind === 'terminology') {
      guideEntries = resolved.guide.payload.entries;
    }
  }
  const glossaryEntries = mergeGlossaryEntries(
    guideEntries,
    localEntries,
  ).slice(0, MAX_GLOSSARY_ENTRIES);

  const { stream, writer } = createWorkflowStream();

  void (async () => {
    try {
      await runTranslationWorkflow({
        sourceText,
        targetLanguage,
        glossaryEntries,
        mode: body.mode,
        maxReviewRounds: body.maxReviewRounds,
        modelId: resolveWorkflowModelId(body.modelId),
        writer,
        signal: req.signal,
      });
      writer.close();
    } catch (error) {
      console.error('[workflows/translation] Failed:', error);
      writer.fail(
        'translation',
        error instanceof Error ? error.message : 'Translation failed',
      );
    }
  })();

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
