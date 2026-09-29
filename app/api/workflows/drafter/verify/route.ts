import { NextRequest } from 'next/server';

import { loadSpecResolver } from '@/lib/services/workflows/drafterSpecLoaders';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { briefForChecks } from '@/lib/services/workflows/shared/drafter/generate';
import { parseBriefInput } from '@/lib/services/workflows/shared/drafter/requestParsing';
import {
  RawVerifyResponse,
  VERIFY_SCHEMA,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  normalizeVerifyResponse,
  verifyMaxTokens,
} from '@/lib/services/workflows/shared/drafter/verify';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';
import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';
import { groundVersion } from '@/lib/utils/shared/drafter/core/grounding';
import { statementKey } from '@/lib/utils/shared/drafter/core/statements';
import { normalizeWithMap } from '@/lib/utils/shared/drafter/core/verify';

import {
  DRAFTER_LIMITS,
  GroundingMark,
  Segment,
  VerifyRequest,
  VerifyResponse,
} from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_SEGMENTS = 30;
const MAX_ID_CHARS = 40;

type Claim = { segmentId: string; text: string };

/**
 * A claim's sentence is checkable only when it is in its segment. Kept
 * claims are unique per segment and sentence key, and capped. The claim
 * text is kept whole (the prompt cuts it): its key is the normalised text
 * cut at MAX_CLAIM_CHARS, exactly as the client stores a verdict, so a
 * long sentence's verdict lands under the key the UI looks up.
 */
function parseClaims(raw: unknown, segments: Segment[]): Claim[] {
  const byId = new Map(
    segments.map((segment) => [
      segment.id,
      normalizeForQuoteMatch(segment.text),
    ]),
  );
  const seen = new Set<string>();
  const claims: Claim[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (
      !entry ||
      typeof entry.segmentId !== 'string' ||
      typeof entry.text !== 'string'
    ) {
      continue;
    }
    // Sliced like the segment ids were, so a long id still finds its segment.
    const segmentId = entry.segmentId.slice(0, MAX_ID_CHARS);
    const segmentText = byId.get(segmentId);
    if (segmentText === undefined) continue;
    const text = entry.text.trim().slice(0, DRAFTER_LIMITS.MAX_SEGMENT_CHARS);
    const normalized = normalizeForQuoteMatch(text);
    if (!normalized || !segmentText.includes(normalized)) continue;
    const key = `${segmentId}\n${statementKey(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ segmentId, text });
    if (claims.length >= DRAFTER_LIMITS.MAX_VERIFY_CLAIMS) break;
  }
  return claims;
}

/**
 * Whether a quote or number the brief lacks sits inside the claim's
 * sentence: the model may not call such a sentence 'supported'.
 */
function ungroundedInside(
  claim: Claim,
  segments: Segment[],
  marks: GroundingMark[],
): boolean {
  const segment = segments.find((entry) => entry.id === claim.segmentId);
  if (!segment) return false;
  const norm = normalizeWithMap(segment.text);
  const needle = normalizeForQuoteMatch(claim.text);
  const at = needle ? norm.text.indexOf(needle) : -1;
  if (at < 0) return false;
  const start = norm.map[at];
  const end = norm.map[at + needle.length - 1] + 1;
  return marks.some(
    (mark) =>
      mark.segmentId === claim.segmentId &&
      (mark.kind === 'quote' || mark.kind === 'number') &&
      mark.itemId === undefined &&
      mark.start >= start &&
      mark.end <= end,
  );
}

/**
 * POST /api/workflows/drafter/verify: the cite step. The model attributes
 * given sentences of a version to the brief entries they rest on. The
 * workspace runs it after generation and after edits; the deterministic
 * marks are computed client-side and never wait on this.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
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

  // One target per spec: a second one for the same spec is dropped, so one
  // request can never fan out several model calls under one budget check.
  const seenSpecs = new Set<string>();
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, DRAFTER_LIMITS.MAX_SPECS)
    .flatMap((target) => {
      const spec =
        target && typeof target.specId === 'string'
          ? resolveSpec(target.specId)
          : undefined;
      if (!spec || seenSpecs.has(spec.id)) return [];
      seenSpecs.add(spec.id);
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
          id: segment.id.slice(0, MAX_ID_CHARS),
          text: segment.text.slice(0, DRAFTER_LIMITS.MAX_SEGMENT_CHARS),
          usedItemIds: [],
        }));
      if (segments.length === 0) return [];
      const claims = parseClaims(target.claims, segments);
      return claims.length > 0 ? [{ spec, segments, claims }] : [];
    });
  if (targets.length === 0) return badRequestResponse('No claims to cite');

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_verify',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const client = createAzureClient();
    const model = resolveWorkflowModelId(body.modelId);
    const checkBrief = briefForChecks(brief);
    const known = new Set(brief.items.map((item) => item.id));

    const settled = await Promise.allSettled(
      targets.map(async ({ spec, segments, claims }) => {
        const marks = groundVersion(segments, checkBrief);
        const ungrounded = claims.map((claim) =>
          ungroundedInside(claim, segments, marks),
        );
        const raw = await callStructured<RawVerifyResponse>({
          client,
          model,
          system: buildVerifySystemPrompt(brief.language),
          user: buildVerifyUserPrompt(brief, segments, claims),
          schemaName: 'drafter_verify',
          schema: VERIFY_SCHEMA,
          maxTokens: verifyMaxTokens(claims.length),
          usage,
          usageLabel: `cite:${spec.id}`,
        });
        return {
          specId: spec.id,
          verdicts: normalizeVerifyResponse(
            raw,
            claims,
            known,
            // Claim indices are 1-based in the prompt and the answer.
            (claimIndex) => ungrounded[claimIndex - 1] === true,
          ),
        };
      }),
    );

    const results: VerifyResponse['results'] = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(
        `[workflows/drafter/verify] ${targets[index].spec.id} failed: ${sanitizeForLog(result.reason)}`,
      );
      return {
        specId: targets[index].spec.id,
        verdicts: [],
        error: 'VERIFY_FAILED',
      };
    });

    return successResponse({ results, ...usage.fields() });
  } catch (error) {
    console.error(
      `[workflows/drafter/verify] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Verification failed');
  }
}
