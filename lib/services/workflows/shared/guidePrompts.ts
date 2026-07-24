/**
 * Prompt blocks for admin-authored guides. Pure builders (no service
 * imports) shared by the document and translation orchestrators and the
 * document generate route; guide bodies arrive here already access-checked
 * and token-budgeted by guideResolution.
 */

/** Minimal resolved-guide shape the prompt layer needs. */
export interface GuidePromptInput {
  /** `guide:<id>` — the criterion id the model rates this guide under. */
  criterionId: string;
  name: string;
  kind: string;
  body: string;
}

const GUIDE_KIND_PREAMBLES: Record<string, string> = {
  style: 'STYLE GUIDE — assess whether the document follows these style rules',
  terminology:
    'TERMINOLOGY GUIDE — assess whether terms are used exactly as this guide prescribes',
  compliance: 'COMPLIANCE GUIDE — flag any content that violates these rules',
};

/**
 * One block per criterion-kind guide, appended to the assessment system
 * prompt after the spec/tone blocks. Each guide is also a rubric line (see
 * guideRubricLine) so the model rates it like any other criterion.
 */
export function buildGuideCriterionBlocks(guides: GuidePromptInput[]): string {
  if (guides.length === 0) return '';
  return guides
    .map(
      (guide) => `

${GUIDE_KIND_PREAMBLES[guide.kind] ?? 'GUIDE'} ("${guide.name}", criterion id "${guide.criterionId}"):
"""
${guide.body}
"""`,
    )
    .join('');
}

/** Rubric line entered into the "Criteria to assess:" list for a guide. */
export function guideRubricLine(guide: GuidePromptInput): string {
  return `${guide.name} (${guide.kind} guide): adherence to the attached ${guide.kind} guide "${guide.name}"`;
}

/**
 * A structure guide filling the document spec slot. Phrased like
 * buildSpecBlock so the specAdherence rubric ("the attached document spec")
 * still refers to something recognizable in the prompt.
 */
export function buildStructureGuideBlock(name: string, body: string): string {
  return `

DOCUMENT SPEC — STRUCTURE GUIDE ("${name}") — the document must follow this guide's structure and requirements:
"""
${body}
"""`;
}

/** A tone guide filling the voice/tone slot; phrased like buildToneBlock. */
export function buildToneGuideBlock(name: string, body: string): string {
  return `

VOICE AND TONE RULES — TONE GUIDE ("${name}"):
"""
${body}
"""`;
}
