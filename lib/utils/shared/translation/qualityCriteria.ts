import { TranslationBuiltinCriterionId } from '@/types/workflow';

/**
 * Translation quality criteria, derived from the MQM (Multidimensional
 * Quality Metrics) framework — the industry-standard typology for
 * translation quality evaluation. Each dimension is rated 1–5; individual
 * proposed edits carry MQM severities (minor/major).
 *
 * One source of truth for ids, UI label keys, and the English rubric
 * lines injected into assessment prompts (prompts are never localized).
 */

export interface TranslationQualityCriterion {
  id: TranslationBuiltinCriterionId;
  /** i18n keys under workflows.translation.criteria.<id>.* */
  labelKey: string;
  descriptionKey: string;
  /** English rubric line for the assessment prompt. */
  promptDescription: string;
}

export const TRANSLATION_QUALITY_CRITERIA: readonly TranslationQualityCriterion[] =
  [
    {
      id: 'accuracy',
      labelKey: 'accuracy',
      descriptionKey: 'accuracy',
      promptDescription:
        'Accuracy: the translation conveys exactly the source meaning — no mistranslation, omission, unjustified addition, or untranslated segments.',
    },
    {
      id: 'fluency',
      labelKey: 'fluency',
      descriptionKey: 'fluency',
      promptDescription:
        'Fluency: the target text is well-formed on its own — grammar, spelling, punctuation, and cohesion read naturally to a native speaker.',
    },
    {
      id: 'terminology',
      labelKey: 'terminology',
      descriptionKey: 'terminology',
      promptDescription:
        'Terminology: domain terms are translated consistently and correctly; any provided glossary is followed exactly — a glossary violation is always at least a major issue.',
    },
    {
      id: 'style',
      labelKey: 'style',
      descriptionKey: 'style',
      promptDescription:
        'Style: register, tone, and voice match the source (formal stays formal, plain stays plain); style is consistent throughout.',
    },
    {
      id: 'localeConventions',
      labelKey: 'localeConventions',
      descriptionKey: 'localeConventions',
      promptDescription:
        'Locale conventions: dates, numbers, units, currency, punctuation, and formatting follow the target language and locale norms.',
    },
    {
      id: 'audience',
      labelKey: 'audience',
      descriptionKey: 'audience',
      promptDescription:
        'Audience appropriateness: the translation suits the apparent purpose and readership of the text (technical for clinicians, plain for the public, etc.).',
    },
  ];

const CRITERION_IDS = new Set<string>(
  TRANSLATION_QUALITY_CRITERIA.map((c) => c.id),
);

export function isTranslationBuiltinCriterionId(
  value: unknown,
): value is TranslationBuiltinCriterionId {
  return typeof value === 'string' && CRITERION_IDS.has(value);
}

/** Undefined for a custom id — callers fall back to the user's rubric. */
export function getCriterion(
  id: string,
): TranslationQualityCriterion | undefined {
  return TRANSLATION_QUALITY_CRITERIA.find((c) => c.id === id);
}

/** The built-in rubric line for `id`, or undefined if it isn't a built-in. */
export function builtinRubricLine(id: string): string | undefined {
  return getCriterion(id)?.promptDescription;
}
