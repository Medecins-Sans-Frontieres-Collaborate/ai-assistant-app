import {
  DOCUMENT_QUALITY_CRITERIA,
  availableDocumentCriteria,
  isCustomCriterionId,
  isDocumentBuiltinCriterionId,
} from '@/lib/utils/shared/document/qualityCriteria';

import { describe, expect, it } from 'vitest';

describe('document quality criteria', () => {
  it('guards builtin ids', () => {
    expect(isDocumentBuiltinCriterionId('grammarSpelling')).toBe(true);
    expect(isDocumentBuiltinCriterionId('custom:abc')).toBe(false);
    expect(isDocumentBuiltinCriterionId('accuracy')).toBe(false); // translation id
  });

  it('detects custom ids by prefix', () => {
    expect(isCustomCriterionId('custom:abc')).toBe(true);
    expect(isCustomCriterionId('grammarSpelling')).toBe(false);
  });

  it('gates spec/tone criteria on attachment', () => {
    const none = availableDocumentCriteria({ hasSpec: false, hasTone: false });
    expect(none.map((c) => c.id)).toEqual([
      'grammarSpelling',
      'consistency',
      'clarity',
      'sensitivity',
    ]);

    const both = availableDocumentCriteria({ hasSpec: true, hasTone: true });
    expect(both.map((c) => c.id)).toContain('specAdherence');
    expect(both.map((c) => c.id)).toContain('toneAdherence');
  });

  it('defaults: sensitivity off, the rest on', () => {
    const defaults = Object.fromEntries(
      DOCUMENT_QUALITY_CRITERIA.map((c) => [c.id, c.defaultOn]),
    );
    expect(defaults.sensitivity).toBe(false);
    expect(defaults.grammarSpelling).toBe(true);
    expect(defaults.consistency).toBe(true);
    expect(defaults.clarity).toBe(true);
  });

  it('grammar rubric encodes mixing-is-the-error', () => {
    const grammar = DOCUMENT_QUALITY_CRITERIA.find(
      (c) => c.id === 'grammarSpelling',
    )!;
    expect(grammar.promptDescription).toMatch(/MIXING/);
  });
});
