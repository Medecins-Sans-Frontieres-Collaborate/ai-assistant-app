import { NextRequest } from 'next/server';

import { loadSpecResolver } from '@/lib/services/workflows/drafterSpecLoaders';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  RawAssessResponse,
  buildAssessSchema,
  buildAssessSystemPrompt,
  normalizeAssessResponse,
} from '@/lib/services/workflows/shared/drafter/assess';
import {
  briefForChecks,
  buildIntentBlock,
} from '@/lib/services/workflows/shared/drafter/generate';
import { parseBriefInput } from '@/lib/services/workflows/shared/drafter/requestParsing';
import { buildReviseUserPrompt } from '@/lib/services/workflows/shared/drafter/revise';
import {
  VOICE_UNAVAILABLE,
  resolveVoices,
  toneBlockFor,
} from '@/lib/services/workflows/shared/drafter/voices';
import {
  buildGuideCriterionBlocks,
  guideRubricLine,
} from '@/lib/services/workflows/shared/guidePrompts';
import { resolveGuideCriteria } from '@/lib/services/workflows/shared/guideResolution';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import {
  admissibleEdits,
  blockingScore,
} from '@/lib/utils/shared/drafter/core/revisions';
import {
  MAX_GUIDES_PER_ASSESSMENT,
  guideCriterionId,
} from '@/lib/utils/shared/review/guideCriteria';

import {
  AssessRequest,
  DRAFTER_CRITERIA,
  DRAFTER_LIMITS,
  ReviseResponse,
  Segment,
} from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_SEGMENTS = 30;

/**
 * POST /api/workflows/drafter/assess: reviews each targeted version against
 * the built-in criteria plus any organisation style / compliance guides, and
 * returns exact-span suggestions in the same shape as a revision. Guides are
 * resolved HERE by id, under the caller's access rules; a guide the caller
 * may not use fails the request rather than being silently skipped, so a
 * review is never reported as having applied a guide it did not.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: AssessRequest;
  try {
    body = (await req.json()) as AssessRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const adapter = getSpecAdapter(body.specKind);
  if (!adapter) return badRequestResponse('Unknown specKind');
  if (!(await isWorkflowEnabled(adapter.workflow))) {
    return workflowDisabledResponse(adapter.workflow);
  }
  // Specs come from the caller's own effective list (admin-edited profiles
  // behind access rules), loaded once. An id they cannot use resolves to
  // nothing, exactly like one that does not exist.
  const loaded = await loadSpecResolver(adapter, req, session, body.setId);
  // Channel settings unreadable: refuse rather than write on defaults.
  if (!loaded.ok) return loaded.response;
  const resolveSpec = loaded.resolve;

  const brief = parseBriefInput(body.brief);
  if (!brief) return badRequestResponse('brief is required');

  const guideIds = [
    ...new Set(
      (Array.isArray(body.guideIds) ? body.guideIds : []).filter(
        (id): id is string => typeof id === 'string' && !!id,
      ),
    ),
  ];
  if (guideIds.length > MAX_GUIDES_PER_ASSESSMENT) {
    return badRequestResponse('Too many guides');
  }

  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, DRAFTER_LIMITS.MAX_SPECS)
    .flatMap((target) => {
      const spec =
        target && typeof target.specId === 'string'
          ? resolveSpec(target.specId)
          : undefined;
      const segments: Segment[] = (
        Array.isArray(target?.segments) ? target.segments : []
      )
        .filter(
          (segment) =>
            segment &&
            typeof segment.id === 'string' &&
            typeof segment.text === 'string' &&
            segment.text.trim(),
        )
        .slice(0, MAX_SEGMENTS)
        .map((segment) => ({
          id: segment.id.slice(0, 40),
          text: segment.text.slice(0, DRAFTER_LIMITS.MAX_SEGMENT_CHARS),
          usedItemIds: [],
        }));
      return spec && segments.length > 0 ? [{ spec, segments }] : [];
    });
  if (targets.length === 0) return badRequestResponse('No assessable targets');

  const userMail = session.user?.mail ?? undefined;
  const resolvedGuides = await resolveGuideCriteria({
    userMail,
    // Style and compliance guides are authored for documents today; one
    // enabled there applies here (design doc §4.2).
    workflow: 'document',
    criterionIds: guideIds.map(guideCriterionId),
  });
  if ('error' in resolvedGuides) {
    return badRequestResponse(resolvedGuides.error, 'GUIDE_UNAVAILABLE');
  }
  const guides = resolvedGuides.guides;

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_assess',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const client = createAzureClient();
    const model = resolveWorkflowModelId(body.modelId);
    const checkBrief = briefForChecks(brief);
    const criterionIds = [
      ...DRAFTER_CRITERIA,
      ...guides.map((guide) => guide.criterionId),
    ];
    const allowed = new Set<string>(criterionIds);
    const voices = await resolveVoices({
      userMail,
      specIds: targets.map((target) => target.spec.id),
      tones: body.tones,
      toneGuideIds: body.toneGuideIds,
    });

    const settled = await Promise.allSettled(
      targets.map(async ({ spec, segments }) => {
        const voice = voices[spec.id];
        if (!voice?.ok) {
          return { specId: spec.id, edits: [], error: VOICE_UNAVAILABLE };
        }
        const text = segments.map((segment) => segment.text).join('\n\n');
        const raw = await callStructured<RawAssessResponse>({
          client,
          model,
          system: buildAssessSystemPrompt({
            specBlock: adapter.promptBlock(spec),
            toneBlock: toneBlockFor(voice.tone),
            language: brief.language,
            intentBlock: buildIntentBlock(brief),
            guideBlocks: buildGuideCriterionBlocks(guides, text),
            guideRubric: guides.map(
              (guide) => `- "${guide.criterionId}": ${guideRubricLine(guide)}`,
            ),
          }),
          user: buildReviseUserPrompt(
            'Review this version against the criteria.',
            segments,
            brief,
          ),
          schemaName: 'drafter_assess',
          schema: buildAssessSchema(criterionIds),
          usage,
          usageLabel: `assess:${spec.id}`,
        });
        return {
          specId: spec.id,
          // Same guard as a revision: a Check suggestion may not push a
          // fitting post over its limit or add an unknown link.
          edits: admissibleEdits(
            normalizeAssessResponse(raw, allowed),
            segments,
            checkBrief,
            undefined,
            (candidate) =>
              blockingScore(checkVersion(adapter, spec, candidate, checkBrief)),
          ),
        };
      }),
    );

    const results: ReviseResponse['results'] = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(
        `[workflows/drafter/assess] ${targets[index].spec.id} failed: ${sanitizeForLog(result.reason)}`,
      );
      return {
        specId: targets[index].spec.id,
        edits: [],
        error: 'ASSESSMENT_FAILED',
      };
    });

    return successResponse({
      results,
      guides: guides.map((guide) => ({
        criterionId: guide.criterionId,
        name: guide.name,
      })),
      ...usage.fields(),
    });
  } catch (error) {
    console.error(
      `[workflows/drafter/assess] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Assessment failed');
  }
}
