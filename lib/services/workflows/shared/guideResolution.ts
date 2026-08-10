import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import {
  GUIDE_SOURCE,
  GuideKind,
  GuidePayload,
  guidePayload,
} from '@/lib/services/agentAccess/types';

import {
  guideCriterionId,
  guideIdFromCriterionId,
  isGuideCriterionKind,
} from '@/lib/utils/shared/review/guideCriteria';

import { truncateToTokenBudget } from './textBudget';

/**
 * Server-side resolution of admin-guide references in workflow requests.
 * Clients send only guide ids; the payloads come from the AgentAccessService
 * snapshot (≤60s stale, PRIMARY-region storage touched only on refresh).
 * Style/compliance bodies are token-budgeted here before they reach any
 * prompt; structured payloads (tone/structure/terminology) are bounded by
 * their write-side caps instead — truncating mid-structure would corrupt
 * them (terminology additionally gets a char budget at render time).
 *
 * FAIL-CLOSED CONTRACT: every failure mode — unknown id, access denied,
 * rules unavailable, wrong workflow, wrong kind, feature disabled, and a
 * record whose payload is incoherent for its kind (guidePayload → null,
 * e.g. legacy body-only structured guides) — aborts with the SAME generic
 * error. Discovery already 404s denied guides identically to missing ones;
 * distinguishing them here would reopen that existence oracle at the
 * invocation path.
 */

/**
 * Per style/compliance body. Sized so a maximal MAX_GUIDE_BODY_CHARS guide
 * (~100k chars ≈ 25k tokens of typical prose) injects whole rather than
 * being silently gutted; the truncation marker still guards token-dense
 * content. Worst case — MAX_GUIDES_PER_ASSESSMENT maximal guides plus a
 * 60k-char document — stays inside current workflow-model context windows.
 */
export const GUIDE_TOKEN_BUDGET = 26_000;

export const GUIDE_UNAVAILABLE_MESSAGE = 'Guide is not available';

export interface ResolvedGuide {
  id: string;
  /** `guide:<id>` — the criterion id this guide is assessed under. */
  criterionId: string;
  name: string;
  kind: GuideKind;
  /** Kind-discriminated payload; bodies arrive already token-budgeted. */
  payload: GuidePayload;
  truncated: boolean;
}

type Resolution<T> = { ok: true; value: T } | { ok: false; error: string };

const FAILED: Resolution<never> = {
  ok: false,
  error: GUIDE_UNAVAILABLE_MESSAGE,
};

async function resolveOne(options: {
  service: AgentAccessService;
  userMail: string | undefined;
  guideId: string;
  workflow: 'document' | 'translation';
}): Promise<Resolution<ResolvedGuide>> {
  const { service, userMail, guideId, workflow } = options;
  const guide = service.getGuideById(guideId);
  if (guide === null) return FAILED;

  const decision = service.evaluateAccess({
    userMail,
    source: GUIDE_SOURCE,
    agentName: guide.id,
  });
  emitAccessAudit({
    userMail,
    agentName: guide.id,
    source: GUIDE_SOURCE,
    decision: decision.decision,
    reason: decision.reason,
  });
  if (decision.decision !== 'allow') return FAILED;
  if (!guide.workflows.includes(workflow)) return FAILED;

  let payload = guidePayload(guide);
  if (payload === null) return FAILED;

  let truncated = false;
  if (payload.kind === 'style' || payload.kind === 'compliance') {
    const budgeted = await truncateToTokenBudget(
      payload.body,
      GUIDE_TOKEN_BUDGET,
    );
    payload = { kind: payload.kind, body: budgeted.text };
    truncated = budgeted.truncated;
  }

  return {
    ok: true,
    value: {
      id: guide.id,
      criterionId: guideCriterionId(guide.id),
      name: guide.name,
      kind: guide.kind,
      payload,
      truncated,
    },
  };
}

/**
 * Resolves `guide:` criterion ids for an assessment. Only criterion kinds
 * (style/terminology/compliance) are valid here — structure/tone guides fill
 * the spec/tone slots via {@link resolveSlotGuide} and never appear as
 * criterion ids.
 */
export async function resolveGuideCriteria(options: {
  userMail: string | undefined;
  workflow: 'document' | 'translation';
  /** Only the `guide:` ids, already extracted by the route. */
  criterionIds: string[];
}): Promise<{ guides: ResolvedGuide[] } | { error: string }> {
  // Nothing requested → nothing to resolve. MUST precede the feature check:
  // assessments that use no guides run fine on deployments where the
  // agent-access subsystem is disabled.
  if (options.criterionIds.length === 0) return { guides: [] };

  const service = AgentAccessService.getInstance();
  // Feature off → guides cannot exist, so any reference to one fails.
  if (!service.isEnabled()) return { error: GUIDE_UNAVAILABLE_MESSAGE };
  await service.ensureFresh();

  const guides: ResolvedGuide[] = [];
  for (const criterionId of options.criterionIds) {
    const resolved = await resolveOne({
      service,
      userMail: options.userMail,
      guideId: guideIdFromCriterionId(criterionId),
      workflow: options.workflow,
    });
    if (!resolved.ok) return { error: resolved.error };
    if (!isGuideCriterionKind(resolved.value.kind)) {
      return { error: GUIDE_UNAVAILABLE_MESSAGE };
    }
    guides.push(resolved.value);
  }
  return { guides };
}

/**
 * Resolves a slot/attachment guide referenced by id: structure/tone guides
 * fill the document workflow's spec/tone slots, terminology guides attach to
 * translation generation as an organization glossary. Same fail-closed
 * contract as criterion resolution.
 */
export async function resolveSlotGuide(options: {
  userMail: string | undefined;
  guideId: string;
  expectedKind: 'structure' | 'tone' | 'terminology';
  workflow: 'document' | 'translation';
}): Promise<{ guide: ResolvedGuide } | { error: string }> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return { error: GUIDE_UNAVAILABLE_MESSAGE };
  await service.ensureFresh();

  const resolved = await resolveOne({
    service,
    userMail: options.userMail,
    guideId: options.guideId,
    workflow: options.workflow,
  });
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.value.kind !== options.expectedKind) {
    return { error: GUIDE_UNAVAILABLE_MESSAGE };
  }
  return { guide: resolved.value };
}
