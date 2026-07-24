/**
 * Admin-guide criterion ids: `guide:<guide-id>`.
 *
 * Deliberately a SEPARATE module from customCriteria.ts: custom criteria are
 * client-supplied definitions bounded by MAX_CRITERION_RUBRIC_CHARS, while
 * guides are resolved server-side by id and their bodies intentionally bypass
 * that cap (they are token-budgeted at prompt injection instead). Mixing the
 * two invites cap-confusion regressions.
 *
 * The prefix cannot collide with built-in criterion ids (plain identifiers)
 * or custom ids (`custom:<uuid>`).
 */
export const GUIDE_CRITERION_PREFIX = 'guide:';

export function isGuideCriterionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(GUIDE_CRITERION_PREFIX);
}

export function guideCriterionId(guideId: string): string {
  return `${GUIDE_CRITERION_PREFIX}${guideId}`;
}

export function guideIdFromCriterionId(criterionId: string): string {
  return criterionId.slice(GUIDE_CRITERION_PREFIX.length);
}

/**
 * One guide body can be ~15× a custom rubric, so the count is capped tighter
 * than MAX_CRITERIA: 3 × GUIDE_TOKEN_BUDGET matches the existing 12k-token
 * reference budget in the document generate route.
 */
export const MAX_GUIDES_PER_ASSESSMENT = 3;
export const MAX_GUIDE_BODY_CHARS = 30_000;
export const MAX_GUIDE_NAME_CHARS = 100;

/**
 * The kinds that behave as assessment criteria. The other two ('structure',
 * 'tone') fill the document workflow's spec/tone attachment slots instead
 * and never appear as criterion ids.
 */
export const GUIDE_CRITERION_KINDS = [
  'style',
  'terminology',
  'compliance',
] as const;
export type GuideCriterionKind = (typeof GUIDE_CRITERION_KINDS)[number];

export function isGuideCriterionKind(kind: string): kind is GuideCriterionKind {
  return (GUIDE_CRITERION_KINDS as readonly string[]).includes(kind);
}
