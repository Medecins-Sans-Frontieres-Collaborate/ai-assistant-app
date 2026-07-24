import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import { GUIDE_SOURCE, GuideKind } from '@/lib/services/agentAccess/types';

import {
  guideCriterionId,
  guideIdFromCriterionId,
  isGuideCriterionKind,
} from '@/lib/utils/shared/review/guideCriteria';

import { truncateToTokenBudget } from './textBudget';

/**
 * Server-side resolution of admin-guide references in workflow requests.
 * Clients send only guide ids; the bodies come from the AgentAccessService
 * snapshot (≤60s stale, PRIMARY-region storage touched only on refresh) and
 * are token-budgeted here before they reach any prompt.
 *
 * FAIL-CLOSED CONTRACT: every failure mode — unknown id, access denied,
 * rules unavailable, wrong workflow, wrong kind, feature disabled — aborts
 * with the SAME generic error. Discovery already 404s denied guides
 * identically to missing ones; distinguishing them here would reopen that
 * existence oracle at the invocation path.
 */

/** Per guide; 3 guides × 4k matches the 12k-token reference budget. */
export const GUIDE_TOKEN_BUDGET = 4_000;

export const GUIDE_UNAVAILABLE_MESSAGE = 'Guide is not available';

export interface ResolvedGuide {
  id: string;
  /** `guide:<id>` — the criterion id this guide is assessed under. */
  criterionId: string;
  name: string;
  kind: GuideKind;
  /** Token-budgeted body, ready for prompt injection. */
  body: string;
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

  const budgeted = await truncateToTokenBudget(guide.body, GUIDE_TOKEN_BUDGET);
  return {
    ok: true,
    value: {
      id: guide.id,
      criterionId: guideCriterionId(guide.id),
      name: guide.name,
      kind: guide.kind,
      body: budgeted.text,
      truncated: budgeted.truncated,
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
 * Resolves a structure/tone guide referenced by the document workflow's
 * spec/tone slot fields. Document-only by construction (the admin write
 * schema pins these kinds to the document workflow).
 */
export async function resolveSlotGuide(options: {
  userMail: string | undefined;
  guideId: string;
  expectedKind: 'structure' | 'tone';
}): Promise<{ guide: ResolvedGuide } | { error: string }> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return { error: GUIDE_UNAVAILABLE_MESSAGE };
  await service.ensureFresh();

  const resolved = await resolveOne({
    service,
    userMail: options.userMail,
    guideId: options.guideId,
    workflow: 'document',
  });
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.value.kind !== options.expectedKind) {
    return { error: GUIDE_UNAVAILABLE_MESSAGE };
  }
  return { guide: resolved.value };
}
