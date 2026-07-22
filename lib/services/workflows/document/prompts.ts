import { DocumentSpec } from '@/types/workflow';

/**
 * Prompt builders for the document-writing workflow. The model always
 * returns the COMPLETE document as markdown (full-replace revision model);
 * granular accept/reject revisions run through the assessment flow.
 */

export interface DocumentReferenceInput {
  name: string;
  text: string;
}

export interface ToneInput {
  name: string;
  voiceRules: string;
  examples?: string;
}

export interface QualityGuidanceItem {
  name: string;
  rubric: string;
}

const BASE_RULES = `You are an expert document writer for a humanitarian organization.

Rules:
- Output ONLY the document itself, in markdown. No preamble, no commentary, no code fences around the whole document.
- Start with a single H1 title line.
- Use clear structure: headings, short paragraphs, lists and tables where they help.
- Write in the language the user writes in unless asked otherwise.`;

const CITATION_RULES = `
Reference material is provided in SOURCE blocks. When you use information from a source:
- Attribute direct quotes and specific claims inline as (Source: <name>).
- Never invent quotes or attribute anything a source does not say.
- Prefer the sources over your own knowledge when they conflict.`;

export function buildReferenceBlock(
  references: DocumentReferenceInput[],
): string {
  if (references.length === 0) return '';
  const blocks = references
    .map((ref) => `SOURCE [${ref.name}]:\n"""\n${ref.text}\n"""`)
    .join('\n\n');
  return `\n\nReference material:\n\n${blocks}`;
}

/** Numbered spec sections + required flags + guidance → prompt block. */
export function buildSpecBlock(spec: DocumentSpec): string {
  const sections = spec.sections
    .map(
      (section, index) =>
        `${index + 1}. ${section.heading}${section.required ? ' (required)' : ' (optional)'}${
          section.guidance ? ` — ${section.guidance}` : ''
        }`,
    )
    .join('\n');
  return `

DOCUMENT SPEC ("${spec.name}") — the document must follow this template, sections in this order:
${sections}${spec.generalGuidance ? `\nGeneral guidance: ${spec.generalGuidance}` : ''}`;
}

export function buildToneBlock(tone: ToneInput): string {
  return `

VOICE AND TONE RULES ("${tone.name}"):
${tone.voiceRules}${tone.examples ? `\nExamples:\n${tone.examples}` : ''}`;
}

export function buildQualityGuidanceBlock(
  items: QualityGuidanceItem[],
): string {
  if (items.length === 0) return '';
  return `

QUALITY CRITERIA to uphold while writing:
${items.map((i) => `- ${i.name}: ${i.rubric}`).join('\n')}`;
}

export function buildGenerateSystemPrompt(
  hasReferences: boolean,
  extraBlocks = '',
): string {
  const base = hasReferences ? `${BASE_RULES}\n${CITATION_RULES}` : BASE_RULES;
  return `${base}${extraBlocks}`;
}

/* ------------------------------------------------------------------ */
/* Agentic pre-assessment (document profile)                           */
/* ------------------------------------------------------------------ */

export function buildProfileSystemPrompt(): string {
  return `You are an editorial analyst. Characterize the given document concisely and concretely: what it is, who it's for, what it's trying to achieve, its register and tone, the language it is written in (any language — never assume English), and the orthographic/regional conventions it follows, explicitly noting any inconsistent mixing of conventions.`;
}

export function buildProfileUserPrompt(docMarkdown: string): string {
  return `Document:
"""
${docMarkdown}
"""`;
}

/* ------------------------------------------------------------------ */
/* Quality assessment                                                  */
/* ------------------------------------------------------------------ */

export function buildDocAssessmentSystemPrompt(
  rubricLines: string[],
  options: {
    specBlock?: string;
    toneBlock?: string;
    /** Profile-detected language + conventions, fed back as context. */
    language?: string;
    conventionNotes?: string;
    /** When set, the assessment is scoped to this excerpt. */
    hasSelection?: boolean;
  } = {},
): string {
  const languageLine = options.language
    ? `\n- The document is written in ${options.language}${
        options.conventionNotes
          ? ` (conventions observed: ${options.conventionNotes})`
          : ''
      }. Assess it on that language's own terms.`
    : '';
  const selectionRules = options.hasSelection
    ? `\n- Assess ONLY the part of the document covered by the highlighted excerpt (provided after the document as plain text). Ratings and summaries describe that region only. Edits may only target content within that region — but each "before" must still be copied verbatim from the DOCUMENT's markdown.`
    : '';
  return `You are a professional editor assessing a document against explicit quality criteria. The document may be in ANY language — never assume English. Write ALL summaries and edit reasons in the document's own language, so the author receives feedback in the language they write in. Rate on EACH requested criterion (1 = unusable, 2 = major rework needed, 3 = usable with fixes, 4 = good, 5 = publication-ready) and propose concrete fixes.

Criteria to assess:
${rubricLines.map((line) => `- ${line}`).join('\n')}

Rules for proposed edits:
- The document is markdown; edits must preserve valid markdown syntax.
- Each edit's "before" must be copied VERBATIM from the document, with enough surrounding words (3 or more) that it appears exactly once.
- Never propose overlapping edits.
- At most 20 edits; prioritize by severity.
- An empty edits list is the correct answer when nothing needs fixing.
- Rate every requested criterion even when proposing no edits for it.${languageLine}${selectionRules}${options.specBlock ?? ''}${options.toneBlock ?? ''}`;
}

export function buildDocAssessmentUserPrompt(
  docMarkdown: string,
  selection?: string,
): string {
  const selectionBlock = selection
    ? `

Highlighted excerpt to assess (plain text of the selected region):
"""
${selection}
"""`
    : '';
  return `Document:
"""
${docMarkdown}
"""${selectionBlock}`;
}

/* ------------------------------------------------------------------ */
/* Selection-scoped revision                                           */
/* ------------------------------------------------------------------ */

export function buildSelectionReviseUserPrompt(
  instruction: string,
  currentDocMarkdown: string,
  selection: string,
  references: DocumentReferenceInput[],
): string {
  return `Here is the current document (context only — do NOT rewrite it):

"""
${currentDocMarkdown}
"""

The author highlighted this excerpt (plain text of the selected region):

"""
${selection}
"""

Apply the following instruction to the EXCERPT ONLY, and return ONLY the revised excerpt in markdown — no preamble, no surrounding document text:

${instruction}${buildReferenceBlock(references)}`;
}

export function buildGenerateUserPrompt(
  instruction: string,
  references: DocumentReferenceInput[],
): string {
  return `Write a document based on this request:\n\n${instruction}${buildReferenceBlock(references)}`;
}

export function buildReviseUserPrompt(
  instruction: string,
  currentDocMarkdown: string,
  references: DocumentReferenceInput[],
): string {
  return `Here is the current document:

"""
${currentDocMarkdown}
"""

Revise it according to this instruction, and return the COMPLETE revised document (not just the changes):

${instruction}${buildReferenceBlock(references)}`;
}
