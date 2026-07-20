import { isCustomCriterionId } from '@/lib/utils/shared/review/customCriteria';
import {
  TRANSLATION_QUALITY_CRITERIA,
  builtinRubricLine,
  getCriterion,
  isTranslationBuiltinCriterionId,
} from '@/lib/utils/shared/translation/qualityCriteria';

import { describe, expect, it } from 'vitest';

describe('TRANSLATION_QUALITY_CRITERIA', () => {
  it('covers the six MQM dimensions', () => {
    expect(TRANSLATION_QUALITY_CRITERIA.map((c) => c.id)).toEqual([
      'accuracy',
      'fluency',
      'terminology',
      'style',
      'localeConventions',
      'audience',
    ]);
  });

  it('gives every built-in a non-empty English rubric for the prompt', () => {
    for (const criterion of TRANSLATION_QUALITY_CRITERIA) {
      expect(criterion.promptDescription.trim()).not.toBe('');
    }
  });

  it('never collides with the custom-id namespace', () => {
    for (const criterion of TRANSLATION_QUALITY_CRITERIA) {
      expect(isCustomCriterionId(criterion.id)).toBe(false);
    }
  });
});

describe('isTranslationBuiltinCriterionId', () => {
  it('accepts built-ins and rejects everything else', () => {
    expect(isTranslationBuiltinCriterionId('accuracy')).toBe(true);
    expect(isTranslationBuiltinCriterionId('custom:abc')).toBe(false);
    // A document criterion must not sneak through the translation route.
    expect(isTranslationBuiltinCriterionId('grammarSpelling')).toBe(false);
    expect(isTranslationBuiltinCriterionId(undefined)).toBe(false);
  });
});

describe('getCriterion / builtinRubricLine', () => {
  it('resolves a built-in', () => {
    expect(getCriterion('accuracy')?.id).toBe('accuracy');
    expect(builtinRubricLine('accuracy')).toContain('Accuracy:');
  });

  it('returns undefined for a custom id rather than throwing', () => {
    // The old signature asserted with `!` and would have crashed here —
    // custom ids now flow through the same lookup.
    expect(getCriterion('custom:abc')).toBeUndefined();
    expect(builtinRubricLine('custom:abc')).toBeUndefined();
  });
});
