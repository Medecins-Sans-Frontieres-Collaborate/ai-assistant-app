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
import { createWorkflowStream } from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';
import { runTranslationWorkflow } from '@/lib/services/workflows/translation/translationOrchestrator';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  MAX_GUIDE_ENTRIES,
  MAX_ORG_GLOSSARIES_PER_REQUEST,
} from '@/lib/utils/shared/review/guideCriteria';
import { sanitizeGlossaryEntry } from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry } from '@/types/workflow';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

/** Client also pre-checks; server is authoritative. */
const MAX_SOURCE_CHARS = 60_000;
/**
 * Merged (org + personal) entries considered per run. Org glossaries are
 * capped at MAX_GUIDE_ENTRIES each on write; the prompt builder then keeps
 * only entries that occur in the source, so this is a sanity ceiling on
 * matcher work, not on prompt size.
 */
const MAX_GLOSSARY_ENTRIES =
  MAX_ORG_GLOSSARIES_PER_REQUEST * MAX_GUIDE_ENTRIES + MAX_GUIDE_ENTRIES;

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
  /**
   * Organization glossaries (admin terminology guides) whose entries merge
   * with — and win over — the personal entries; among guides the first
   * listed wins. Resolved server-side by id, fail-closed. At most
   * MAX_ORG_GLOSSARIES_PER_REQUEST.
   */
  glossaryGuideIds?: string[];
  /** Legacy single-guide form of `glossaryGuideIds`. */
  glossaryGuideId?: string;
  mode: 'quick' | 'agentic';
  maxReviewRounds?: number;
  modelId?: string;
  /** Correlates the run's calls in telemetry; not otherwise used. */
  conversationId?: string;
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

  // Group-membership warm-up MUST precede resolveOrgGlossaries below — guide
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

  // Trimmed, length-capped, `kind` validated (issue #131) — the entries
  // become prompt text and regex input, so their shape is never trusted.
  const localEntries: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries
        .map((e: unknown) => sanitizeGlossaryEntry(e))
        .filter((e): e is GlossaryEntry => e !== null)
        // Personal glossaries share the org per-glossary ceiling; anything
        // past it is a client bug or an abuse attempt, never a real termbase.
        .slice(0, MAX_GUIDE_ENTRIES)
    : [];

  // Organization glossaries: resolved fail-closed BEFORE the stream opens
  // so a stale/revoked reference is a clean 400. Guide entries come first
  // and win on duplicate source terms — org terminology is authoritative.
  const guideIds = requestedGuideIds(body);
  if (guideIds === null) {
    return badRequestResponse(
      `At most ${MAX_ORG_GLOSSARIES_PER_REQUEST} organization glossaries per run`,
    );
  }
  const resolved = await resolveOrgGlossaries(
    session.user?.mail ?? undefined,
    guideIds,
  );
  if ('error' in resolved) return badRequestResponse(resolved.error);
  const glossaryEntries = mergeGlossaryEntries(
    resolved.entries,
    localEntries,
  ).slice(0, MAX_GLOSSARY_ENTRIES);

  // Workflow runs debit the shared chat token pool, so they honour its
  // pre-flight too (docs/WORKFLOW_EMISSIONS_DESIGN.md §7b).
  const { denied, usage } = await beginWorkflowRun(
    session,
    body.mode === 'agentic' ? 'translate:agentic' : 'translate',
    body.conversationId,
  );
  if (denied) return denied;

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
        usage,
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
