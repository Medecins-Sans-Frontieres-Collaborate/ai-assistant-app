import { NextRequest } from 'next/server';

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

  const glossaryEntries: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries
        .filter(
          (e): e is GlossaryEntry =>
            !!e && typeof e.source === 'string' && typeof e.target === 'string',
        )
        .slice(0, MAX_GLOSSARY_ENTRIES)
    : [];

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
