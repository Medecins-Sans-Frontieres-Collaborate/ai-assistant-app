import { DocumentBuiltinCriterionId } from '@/types/workflow';

/**
 * Built-in document quality criteria. Users can add custom criteria
 * ('custom:<uuid>' ids, settingsStore `documentCriteria`) that run
 * through the same assessment machinery with user-supplied rubrics.
 */

export interface DocumentQualityCriterion {
  id: DocumentBuiltinCriterionId;
  /** i18n keys under workflows.document.criteria.<id>.* */
  labelKey: string;
  descriptionKey: string;
  /** English rubric line for the assessment prompt (never localized). */
  promptDescription: string;
  /** Checked by default in the criteria picker. */
  defaultOn: boolean;
  /** Only available when a spec/tone is attached to the document. */
  requires?: 'spec' | 'tone';
}

export const DOCUMENT_QUALITY_CRITERIA: readonly DocumentQualityCriterion[] = [
  {
    id: 'grammarSpelling',
    labelKey: 'grammarSpelling',
    descriptionKey: 'grammarSpelling',
    promptDescription:
      "Grammar and spelling: the text is grammatically correct and correctly spelled for the document's language. Any internally consistent regional convention or orthography is acceptable — inconsistent MIXING of conventions within the document is the error, never the choice of convention.",
    defaultOn: true,
  },
  {
    id: 'consistency',
    labelKey: 'consistency',
    descriptionKey: 'consistency',
    promptDescription:
      'Language consistency: terminology, names, capitalization, abbreviations, and formatting conventions are used the same way throughout the document.',
    defaultOn: true,
  },
  {
    id: 'clarity',
    labelKey: 'clarity',
    descriptionKey: 'clarity',
    promptDescription:
      'Clarity and readability: sentences are direct and unambiguous; the structure supports the reader; no needless jargon or filler.',
    defaultOn: true,
  },
  {
    id: 'sensitivity',
    labelKey: 'sensitivity',
    descriptionKey: 'sensitivity',
    promptDescription:
      'Sensitive language: wording is inclusive and conflict/humanitarian-sensitive; avoids stigmatizing, dehumanizing, or politically loaded phrasing.',
    defaultOn: false,
  },
  {
    id: 'specAdherence',
    labelKey: 'specAdherence',
    descriptionKey: 'specAdherence',
    promptDescription:
      'Spec adherence: the document follows the attached document spec — all required sections present, in the specified order, each fulfilling its guidance.',
    defaultOn: true,
    requires: 'spec',
  },
  {
    id: 'toneAdherence',
    labelKey: 'toneAdherence',
    descriptionKey: 'toneAdherence',
    promptDescription:
      'Tone adherence: the document follows the attached voice and tone rules.',
    defaultOn: true,
    requires: 'tone',
  },
];

const BUILTIN_IDS = new Set<string>(DOCUMENT_QUALITY_CRITERIA.map((c) => c.id));

export function isDocumentBuiltinCriterionId(
  value: unknown,
): value is DocumentBuiltinCriterionId {
  return typeof value === 'string' && BUILTIN_IDS.has(value);
}

export function isCustomCriterionId(value: string): boolean {
  return value.startsWith('custom:');
}

/** The built-ins offerable given what's attached to the document. */
export function availableDocumentCriteria(options: {
  hasSpec: boolean;
  hasTone: boolean;
}): DocumentQualityCriterion[] {
  return DOCUMENT_QUALITY_CRITERIA.filter((c) => {
    if (c.requires === 'spec') return options.hasSpec;
    if (c.requires === 'tone') return options.hasTone;
    return true;
  });
}
