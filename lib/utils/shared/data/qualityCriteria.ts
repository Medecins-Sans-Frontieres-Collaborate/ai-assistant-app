import { DataBuiltinCriterionId } from '@/types/workflow';

/**
 * Built-in data-quality criteria (tabular counterpart to the document
 * set). Deliberately EXCLUDES completeness: missing counts are computed
 * exactly by columnStats and fed to the prompt as ground truth — the
 * model never rates what the client can count.
 */

export interface DataQualityCriterion {
  id: DataBuiltinCriterionId;
  /** i18n keys under workflows.data.criteria.<id>.* */
  labelKey: string;
  descriptionKey: string;
  /** English rubric line for the assessment prompt (never localized). */
  promptDescription: string;
  defaultOn: boolean;
}

export const DATA_QUALITY_CRITERIA: readonly DataQualityCriterion[] = [
  {
    id: 'validity',
    labelKey: 'validity',
    descriptionKey: 'validity',
    promptDescription:
      "Validity: each value conforms to its column's declared type and expected format (dates parse as dates, numbers are numbers, codes match their scheme); flag malformed or wrongly-typed cells.",
    defaultOn: true,
  },
  {
    id: 'consistency',
    labelKey: 'consistency',
    descriptionKey: 'consistency',
    promptDescription:
      "Consistency: the same real-world value is written the same way throughout — flag categorical variants ('M' / 'Male' / 'Hombre'), casing and whitespace variants, mixed units or formats within a column; propose the majority spelling as the canonical form.",
    defaultOn: true,
  },
  {
    id: 'duplicates',
    labelKey: 'duplicates',
    descriptionKey: 'duplicates',
    promptDescription:
      'Duplicates: rows that record the same real-world entity or event twice (exact copies or near-duplicates differing only in formatting); propose deleting the redundant row, keeping the more complete one.',
    defaultOn: true,
  },
  {
    id: 'plausibility',
    labelKey: 'plausibility',
    descriptionKey: 'plausibility',
    promptDescription:
      'Plausibility: values that are possible to type but implausible in context — extreme outliers, impossible dates or ages, magnitudes inconsistent with the rest of the column; only propose a correction when the intended value is evident (e.g. an obvious unit or decimal slip), otherwise rate without an edit.',
    defaultOn: true,
  },
];

const BUILTIN_IDS = new Set<string>(DATA_QUALITY_CRITERIA.map((c) => c.id));

export function isDataBuiltinCriterionId(
  value: unknown,
): value is DataBuiltinCriterionId {
  return typeof value === 'string' && BUILTIN_IDS.has(value);
}
