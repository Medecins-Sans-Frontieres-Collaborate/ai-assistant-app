/**
 * Prompt builders for the agentic translation workflow. The translation
 * base prompt mirrors the proven markdown-preserving rules of
 * `app/api/chat/translate/route.ts` (which stays untouched — it serves the
 * per-message translate feature).
 */
import { buildGlossaryBlock } from '../shared/glossaryPrompts';

// Re-exported for the orchestrator and existing call sites; the
// implementation moved to shared/glossaryPrompts.ts so admin terminology
// guides render through the same block.
export { buildGlossaryBlock };

export const TRANSLATION_BASE_RULES = `You are an expert multilingual translator. Translate accurately while preserving:

1. **Markdown formatting**: headers, lists, bold, italic, links, and other markdown syntax stay exactly as they are
2. **Code blocks**: keep code unchanged — only translate comments within code
3. **Technical terms**: keep technical terminology unless a standard translation exists in the target language
4. **Tone and style**: match the original register (formal, casual, technical…)
5. **Structure**: preserve paragraph breaks, line breaks, and document structure

URLs, email addresses, and numbers stay unchanged (adapt number/date formats to target-language conventions where appropriate).
Output ONLY the translation — no preamble, no commentary.`;

export function buildAnalysisSystemPrompt(): string {
  return `You are a translation reviewer preparing a briefing for a translator. Identify what will be difficult about translating the given text: tricky terms, ambiguous passages, and the register to preserve. Be concise and concrete; skip anything unremarkable.`;
}

export function buildAnalysisUserPrompt(
  sourceText: string,
  targetLanguage: string,
): string {
  return `The text below will be translated into ${targetLanguage}. Analyze it for translation difficulties.

Text:
"""
${sourceText}
"""`;
}

export function buildTranslationSystemPrompt(
  glossaryBlock: string,
  analysisNotes?: string,
): string {
  let prompt = TRANSLATION_BASE_RULES + glossaryBlock;
  if (analysisNotes) {
    prompt += `

Pre-translation analysis to take into account:
${analysisNotes}`;
  }
  return prompt;
}

export function buildTranslationUserPrompt(
  sourceText: string,
  targetLanguage: string,
): string {
  return `Translate the following text into ${targetLanguage}.

Source text:
"""
${sourceText}
"""`;
}

export function buildReviewSystemPrompt(glossaryBlock: string): string {
  return `You are a meticulous translation reviewer. Compare the translation against the source for accuracy, completeness, terminology, register, and formatting preservation. Report real problems only — do not invent issues to seem thorough. If the translation is publication-ready, approve it.${glossaryBlock}`;
}

export function buildReviewUserPrompt(
  sourceText: string,
  translation: string,
  targetLanguage: string,
  priorIssues: string[],
): string {
  const prior =
    priorIssues.length > 0
      ? `\n\nIssues raised in earlier review rounds (verify they are fixed; do not re-raise fixed ones):\n- ${priorIssues.join('\n- ')}`
      : '';
  return `Source text:
"""
${sourceText}
"""

Translation into ${targetLanguage}:
"""
${translation}
"""${prior}`;
}

/* ------------------------------------------------------------------ */
/* Quality assessment (MQM-derived)                                    */
/* ------------------------------------------------------------------ */

export function buildAssessmentSystemPrompt(
  rubricLines: string[],
  glossaryBlock: string,
  /** Admin-guide bodies for requested `guide:` criteria (pre-budgeted). */
  extraBlocks = '',
): string {
  return `You are a professional translation quality assessor using MQM-derived criteria. Rate the translation against the source on EACH requested criterion (1 = unusable, 2 = major rework needed, 3 = usable with fixes, 4 = good, 5 = publication-ready) and propose concrete fixes.

Criteria to assess:
${rubricLines.map((line) => `- ${line}`).join('\n')}

Rules for proposed edits:
- Each edit's "before" must be copied VERBATIM from the translation, with enough surrounding words (3 or more) that it appears exactly once.
- Never propose overlapping edits.
- At most 20 edits; prioritize by severity.
- An empty edits list is the correct answer when nothing needs fixing.
- Rate every requested criterion even when proposing no edits for it.${glossaryBlock}${extraBlocks}`;
}

export function buildAssessmentUserPrompt(
  sourceText: string,
  translation: string,
  targetLanguage: string,
): string {
  return `Source text:
"""
${sourceText}
"""

Translation into ${targetLanguage}:
"""
${translation}
"""`;
}

/** Turns an analysis result into compact notes for the translation prompt. */
export function analysisToNotes(analysis: {
  trickyTerms: Array<{ term: string; issue: string; suggestion: string }>;
  ambiguities: Array<{ text: string; readings: string[] }>;
  register: string;
  notes: string;
}): string {
  const parts: string[] = [];
  if (analysis.register) parts.push(`Register: ${analysis.register}`);
  for (const t of analysis.trickyTerms.slice(0, 30)) {
    parts.push(`Term "${t.term}": ${t.issue} → ${t.suggestion}`);
  }
  for (const a of analysis.ambiguities.slice(0, 15)) {
    parts.push(`Ambiguous "${a.text}": readings — ${a.readings.join(' / ')}`);
  }
  if (analysis.notes) parts.push(analysis.notes);
  return parts.join('\n');
}
