import {
  MAX_CRITERION_NAME_CHARS,
  MAX_CRITERION_RUBRIC_CHARS,
  collectCustomCriteria,
  criterionRubricLine,
  customCriterionId,
  isCustomCriterionId,
} from '@/lib/utils/shared/review/customCriteria';

import { describe, expect, it } from 'vitest';

describe('custom criterion ids', () => {
  it('namespaces ids so they cannot collide with built-ins', () => {
    const id = customCriterionId('abc-123');
    expect(id).toBe('custom:abc-123');
    expect(isCustomCriterionId(id)).toBe(true);
  });

  it('rejects built-in ids and non-strings', () => {
    expect(isCustomCriterionId('accuracy')).toBe(false);
    expect(isCustomCriterionId('grammarSpelling')).toBe(false);
    expect(isCustomCriterionId(undefined)).toBe(false);
    expect(isCustomCriterionId(42)).toBe(false);
  });
});

describe('collectCustomCriteria', () => {
  const valid = { id: 'custom:a', name: 'Brand', rubric: 'No superlatives' };

  it('keeps well-formed definitions, keyed by id', () => {
    const byId = collectCustomCriteria([valid]);
    expect(byId.get('custom:a')).toEqual({
      name: 'Brand',
      rubric: 'No superlatives',
    });
  });

  it('handles a missing list', () => {
    expect(collectCustomCriteria(undefined).size).toBe(0);
  });

  it('drops definitions that could only produce a blank rubric line', () => {
    const byId = collectCustomCriteria([
      { id: 'custom:blank-name', name: '   ', rubric: 'r' },
      { id: 'custom:blank-rubric', name: 'n', rubric: '  ' },
      { id: 'custom:no-rubric', name: 'n' },
      { id: 'accuracy', name: 'n', rubric: 'r' }, // not a custom id
      { name: 'n', rubric: 'r' }, // no id
    ]);
    expect(byId.size).toBe(0);
  });

  it('drops definitions that exceed the length caps', () => {
    const byId = collectCustomCriteria([
      {
        id: 'custom:long-name',
        name: 'x'.repeat(MAX_CRITERION_NAME_CHARS + 1),
        rubric: 'r',
      },
      {
        id: 'custom:long-rubric',
        name: 'n',
        rubric: 'x'.repeat(MAX_CRITERION_RUBRIC_CHARS + 1),
      },
    ]);
    expect(byId.size).toBe(0);
  });

  it('accepts definitions exactly at the caps', () => {
    const byId = collectCustomCriteria([
      {
        id: 'custom:at-cap',
        name: 'x'.repeat(MAX_CRITERION_NAME_CHARS),
        rubric: 'x'.repeat(MAX_CRITERION_RUBRIC_CHARS),
      },
    ]);
    expect(byId.size).toBe(1);
  });
});

describe('criterionRubricLine', () => {
  const byId = new Map([
    ['custom:a', { name: 'Brand', rubric: 'No superlatives' }],
  ]);

  it('prefers the built-in rubric when there is one', () => {
    expect(criterionRubricLine('accuracy', 'Accuracy: …', byId)).toBe(
      'Accuracy: …',
    );
  });

  it('renders a custom criterion as "name: rubric"', () => {
    expect(criterionRubricLine('custom:a', undefined, byId)).toBe(
      'Brand: No superlatives',
    );
  });

  it('returns null for an unknown id so callers emit no blank bullet', () => {
    expect(criterionRubricLine('custom:missing', undefined, byId)).toBeNull();
  });
});
