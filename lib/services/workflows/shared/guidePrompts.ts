import { GuidePayload } from '@/lib/services/agentAccess/types';

import { DocumentSpec } from '@/types/workflow';

import {
  GUIDE_GLOSSARY_BLOCK_CHAR_BUDGET,
  buildGlossaryBlock,
} from './glossaryPrompts';

/**
 * Prompt blocks for admin-authored guides. Pure builders (no service
 * imports) shared by the document and translation orchestrators and the
 * document generate route; guide payloads arrive here already access-checked
 * and (where applicable) token-budgeted by guideResolution.
 *
 * Structure and tone guides do NOT render here: they convert to the real
 * DocumentSpec / ToneInput shapes (converters below) and flow through the
 * workflow's own buildSpecBlock / buildToneBlock — one prompt path per slot.
 */

/** Minimal resolved-guide shape the prompt layer needs. */
export interface GuidePromptInput {
  /** `guide:<id>` — the criterion id the model rates this guide under. */
  criterionId: string;
  name: string;
  payload: GuidePayload;
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
 *
 * `contextText` is the text under assessment (docMarkdown for the document
 * workflow, sourceText for translation): terminology guides filter their
 * entries to the terms that actually occur in it, exactly like local
 * glossaries do at translation time. When nothing matches, a one-line note
 * renders instead so the guide's rubric line never references a missing
 * block.
 */
export function buildGuideCriterionBlocks(
  guides: GuidePromptInput[],
  contextText: string,
): string {
  if (guides.length === 0) return '';
  return guides
    .map((guide) => {
      const preamble = `${GUIDE_KIND_PREAMBLES[guide.payload.kind] ?? 'GUIDE'} ("${guide.name}", criterion id "${guide.criterionId}"):`;
      if (guide.payload.kind === 'terminology') {
        const table = buildGlossaryBlock(
          guide.payload.entries,
          contextText,
          GUIDE_GLOSSARY_BLOCK_CHAR_BUDGET,
        );
        return `

${preamble}${
          table ||
          `
(No terms from this guide occur in the text — rate the criterion 5 and propose no edits for it.)`
        }`;
      }
      if (
        guide.payload.kind === 'style' ||
        guide.payload.kind === 'compliance'
      ) {
        return `

${preamble}
"""
${guide.payload.body}
"""`;
      }
      // structure/tone are slot guides, never criteria — resolution filters
      // them out before this builder runs.
      return '';
    })
    .join('');
}

/** Rubric line entered into the "Criteria to assess:" list for a guide. */
export function guideRubricLine(guide: GuidePromptInput): string {
  const kind = guide.payload.kind;
  return `${guide.name} (${kind} guide): adherence to the attached ${kind} guide "${guide.name}"`;
}

/**
 * A structure guide as the DocumentSpec shape buildSpecBlock consumes. The
 * spec id is the guide id and timestamps are nominal — only name/sections/
 * generalGuidance reach the prompt.
 */
export function structureGuideToSpec(guide: {
  id: string;
  name: string;
  payload: GuidePayload;
}): DocumentSpec | null {
  if (guide.payload.kind !== 'structure') return null;
  return {
    id: guide.id,
    name: guide.name,
    sections: guide.payload.sections,
    generalGuidance: guide.payload.generalGuidance,
    createdAt: '',
    updatedAt: '',
  };
}

/** A tone guide as the ToneInput shape buildToneBlock consumes. */
export function toneGuideToToneInput(guide: {
  name: string;
  payload: GuidePayload;
}): { name: string; voiceRules: string; examples?: string } | null {
  if (guide.payload.kind !== 'tone') return null;
  return {
    name: guide.name,
    voiceRules: guide.payload.voiceRules,
    examples: guide.payload.examples,
  };
}
