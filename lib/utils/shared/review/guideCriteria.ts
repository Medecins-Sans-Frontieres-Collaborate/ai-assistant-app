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

export function isGuideCriterionId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(GUIDE_CRITERION_PREFIX);
}

export function guideCriterionId(guideId: string): string {
  return `${GUIDE_CRITERION_PREFIX}${guideId}`;
}

export function guideIdFromCriterionId(criterionId: string): string {
  return criterionId.slice(GUIDE_CRITERION_PREFIX.length);
}

/**
 * One guide body can be ~50× a custom rubric, so the count is capped tighter
 * than MAX_CRITERIA — 3 maximal bodies (× GUIDE_TOKEN_BUDGET each) is the
 * most prompt the assessment call is allowed to spend on guides.
 */
export const MAX_GUIDES_PER_ASSESSMENT = 3;
/** style/compliance `body` — long-form office standards can run far past
 * what fits a form field, so the cap is storage sanity, not a prompt budget
 * (GUIDE_TOKEN_BUDGET governs injection). */
export const MAX_GUIDE_BODY_CHARS = 100_000;
/** tone `voiceRules`/`examples` individually — voice profiles stay compact. */
export const MAX_GUIDE_VOICE_CHARS = 30_000;
export const MAX_GUIDE_NAME_CHARS = 100;

/** Structure-guide caps — MAX_GUIDE_SECTIONS aligns MAX_SPEC_SECTIONS. */
export const MAX_GUIDE_SECTIONS = 30;
export const MAX_GUIDE_SECTION_HEADING_CHARS = 200;
export const MAX_GUIDE_SECTION_GUIDANCE_CHARS = 500;
export const MAX_GUIDE_GENERAL_GUIDANCE_CHARS = 5_000;

/** Terminology-guide caps — MAX_GUIDE_ENTRIES aligns MAX_GLOSSARY_ENTRIES. */
export const MAX_GUIDE_ENTRIES = 200;
export const MAX_GUIDE_TERM_CHARS = 120;
export const MAX_GUIDE_TERM_NOTE_CHARS = 300;

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
