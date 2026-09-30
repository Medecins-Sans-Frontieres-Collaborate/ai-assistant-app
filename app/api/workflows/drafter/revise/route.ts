import { NextRequest } from 'next/server';

import { loadSpecResolver } from '@/lib/services/workflows/drafterSpecLoaders';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  briefForChecks,
  buildIntentBlock,
} from '@/lib/services/workflows/shared/drafter/generate';
import { parseBriefInput } from '@/lib/services/workflows/shared/drafter/requestParsing';
import {
  MAX_TIGHTEN_ROUNDS,
  Overage,
  REVISE_SCHEMA,
  RawReviseResponse,
  buildReviseSystemPrompt,
  buildReviseUserPrompt,
  buildTightenInstruction,
  normalizeReviseResponse,
} from '@/lib/services/workflows/shared/drafter/revise';
import {
  VOICE_UNAVAILABLE,
  resolveVoices,
  toneBlockFor,
} from '@/lib/services/workflows/shared/drafter/voices';
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
  applyProposals,
  blockingScore,
} from '@/lib/utils/shared/drafter/core/revisions';

import {
  DRAFTER_LIMITS,
  ProposedEdit,
  ReviseRequest,
  ReviseResponse,
  Segment,
} from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_SEGMENTS = 30;

/**
 * POST /api/workflows/drafter/revise: turns one instruction into exact-span
 * suggestions for each targeted version. One parallel call per target; a
 * failed target does not fail the others. Every proposal is filtered through
 * `admissibleEdits`, so a suggestion can never reword a quotation from the
 * brief or touch a link, whatever the model returned.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: ReviseRequest;
  try {
    body = (await req.json()) as ReviseRequest;
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

  const tighten = body.mode === 'tighten';
  const instruction =
    typeof body.instruction === 'string'
      ? body.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS)
      : '';
  // A tighten request's instruction is written here, from a measurement.
  if (!tighten && !instruction) {
    return badRequestResponse('instruction is required');
  }

  const brief = parseBriefInput(body.brief);
  if (!brief) return badRequestResponse('brief is required');

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
      if (!spec || segments.length === 0) return [];
      const segmentId =
        typeof target.segmentId === 'string' &&
        segments.some((segment) => segment.id === target.segmentId)
          ? target.segmentId
          : undefined;
      return [{ spec, segments, segmentId }];
    });
  if (targets.length === 0) return badRequestResponse('No revisable targets');

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_revise',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const client = createAzureClient();
    const model = resolveWorkflowModelId(body.modelId);
    const checkBrief = briefForChecks(brief);
    const voices = await resolveVoices({
      userMail: session.user?.mail ?? undefined,
      specIds: targets.map((target) => target.spec.id),
      tones: body.tones,
      toneGuideIds: body.toneGuideIds,
    });

    const settled = await Promise.allSettled(
      targets.map(async ({ spec, segments, segmentId }) => {
        const voice = voices[spec.id];
        if (!voice?.ok) {
          return { specId: spec.id, edits: [], error: VOICE_UNAVAILABLE };
        }
        const system = buildReviseSystemPrompt(
          adapter.promptBlock(spec),
          toneBlockFor(voice.tone),
          brief.language,
          buildIntentBlock(brief),
        );
        const findingsOf = (candidate: Segment[]) =>
          checkVersion(adapter, spec, candidate, checkBrief);
        // A suggestion that makes things worse (pushes a fitting post over
        // its limit, adds a link the brief does not carry) is never shown.
        const guard = (candidate: Segment[]): number =>
          blockingScore(findingsOf(candidate));
        const ask = async (text: string, label: string) =>
          admissibleEdits(
            normalizeReviseResponse(
              await callStructured<RawReviseResponse>({
                client,
                model,
                system,
                user: buildReviseUserPrompt(text, segments, brief, segmentId),
                schemaName: 'drafter_revise',
                schema: REVISE_SCHEMA,
                usage,
                usageLabel: label,
              }),
            ),
            segments,
            checkBrief,
            segmentId,
            guard,
          );
        if (!tighten) {
          return {
            specId: spec.id,
            edits: await ask(instruction, `revise:${spec.id}`),
          };
        }

        const overagesOf = (candidate: Segment[]): Overage[] =>
          findingsOf(candidate)
            .filter(
              (finding) =>
                finding.checkId === 'length' &&
                !!finding.targetId &&
                (!segmentId || finding.targetId === segmentId),
            )
            .map((finding) => ({
              segmentId: finding.targetId as string,
              over: Number(finding.values?.count ?? 0),
            }));
        const total = (list: Overage[]): number =>
          list.reduce((sum, entry) => sum + entry.over, 0);

        const start = overagesOf(segments);
        if (start.length === 0) return { specId: spec.id, edits: [] };
        // Bounded, and the BEST round is returned rather than the last:
        // each round is measured by applying its edits to the real text.
        let best: { edits: ProposedEdit[]; stillOver: Overage[] } | undefined;
        for (let round = 1; round <= MAX_TIGHTEN_ROUNDS; round += 1) {
          const edits = await ask(
            buildTightenInstruction(start, best),
            `tighten${round}:${spec.id}`,
          );
          const stillOver = overagesOf(applyProposals(segments, edits));
          if (
            edits.length > 0 &&
            (!best || total(stillOver) < total(best.stillOver))
          ) {
            best = { edits, stillOver };
          }
          if (best && best.stillOver.length === 0) break;
        }
        return {
          specId: spec.id,
          edits: best?.edits ?? [],
          stillOver: best ? total(best.stillOver) : total(start),
        };
      }),
    );

    const results: ReviseResponse['results'] = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(
        `[workflows/drafter/revise] ${targets[index].spec.id} failed: ${sanitizeForLog(result.reason)}`,
      );
      return {
        specId: targets[index].spec.id,
        edits: [],
        error: 'REVISION_FAILED',
      };
    });

    return successResponse({ results, ...usage.fields() });
  } catch (error) {
    console.error(
      `[workflows/drafter/revise] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Revision failed');
  }
}
