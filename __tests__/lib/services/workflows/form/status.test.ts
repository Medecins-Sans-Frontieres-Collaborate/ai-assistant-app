import {
  coverageOf,
  fieldStatus,
  fillableFieldIds,
  openFieldIds,
} from '@/lib/services/workflows/form/status';

import { FieldFill, FormDocument, FormTemplate } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const template: FormTemplate = {
  id: 't',
  name: 'T',
  sections: [{ id: 's', heading: 'S' }],
  fields: [
    { id: 'a', sectionId: 's', label: 'A', type: 'text', required: true },
    { id: 'b', sectionId: 's', label: 'B', type: 'longtext', required: false },
    {
      id: 'c',
      sectionId: 's',
      label: 'C',
      type: 'number',
      required: true,
      validation: { max: 10 },
    },
    {
      id: 'locked',
      sectionId: 's',
      label: 'L',
      type: 'text',
      required: false,
      admin: { locked: true },
    },
  ],
  layout: '',
  origin: 'user',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const fill = (partial: Partial<FieldFill>): FieldFill => ({
  value: null,
  provenance: [],
  updatedAt: '2026-01-01T00:00:00Z',
  ...partial,
});

function doc(fields: Record<string, FieldFill>): FormDocument {
  return {
    id: 'd',
    template,
    language: 'English',
    fields,
    questions: [],
    runs: [],
    proposals: [],
  };
}

describe('fieldStatus', () => {
  const [a, , c, locked] = template.fields;

  it('is empty without a value', () => {
    expect(fieldStatus(a, undefined).status).toBe('empty');
    expect(fieldStatus(a, fill({ value: '  ' })).status).toBe('empty');
  });

  it('is filled only when sourced, valid and gap-free', () => {
    const sourced = fill({
      value: 'x',
      provenance: [{ sourceId: 's1', excerpt: 'x' }],
    });
    expect(fieldStatus(a, sourced).status).toBe('filled');
  });

  it('is partial when unsourced, gapped, or invalid', () => {
    expect(fieldStatus(a, fill({ value: 'x' })).partialReasons).toEqual([
      'unsourced',
    ]);
    expect(
      fieldStatus(
        a,
        fill({ value: 'x', gaps: 'missing date', generalKnowledge: true }),
      ).partialReasons,
    ).toEqual(['gaps']);
    const invalid = fieldStatus(
      c,
      fill({ value: 99, provenance: [{ sourceId: 's', excerpt: 'e' }] }),
    );
    expect(invalid.status).toBe('partial');
    expect(invalid.issues.map((i) => i.code)).toEqual(['max']);
  });

  it('general knowledge counts as sourced', () => {
    expect(
      fieldStatus(a, fill({ value: 'Paris', generalKnowledge: true })).status,
    ).toBe('filled');
  });

  it('honours decisions and locks', () => {
    expect(
      fieldStatus(a, fill({ value: 'x', decision: 'confirmed' })).status,
    ).toBe('confirmed');
    expect(fieldStatus(a, fill({ decision: 'not_applicable' })).status).toBe(
      'not_applicable',
    );
    expect(fieldStatus(locked, fill({ value: 'org' })).status).toBe(
      'confirmed',
    );
    // A confirmed empty value is still empty — the user cleared it.
    expect(fieldStatus(a, fill({ decision: 'confirmed' })).status).toBe(
      'empty',
    );
  });
});

describe('coverageOf / target lists', () => {
  it('counts statuses and required coverage', () => {
    const d = doc({
      a: fill({ value: 'x', decision: 'confirmed' }),
      b: fill({ value: 'y' }),
      c: fill({ decision: 'not_applicable' }),
    });
    const coverage = coverageOf(d);
    // The locked field counts as confirmed even without a value.
    expect(coverage).toMatchObject({
      total: 4,
      confirmed: 2,
      partial: 1,
      notApplicable: 1,
      empty: 0,
      requiredTotal: 2,
      requiredAddressed: 2,
      requiredRatio: 1,
    });
    expect(coverage.ratio).toBeCloseTo(0.75);
  });

  it('never targets confirmed, N/A or locked fields; opens required first', () => {
    const d = doc({
      a: fill({ value: 'x' }),
      c: fill({ decision: 'not_applicable' }),
      locked: fill({ value: 'org' }),
    });
    expect(fillableFieldIds(d)).toEqual(['a', 'b']);
    expect(openFieldIds(d)).toEqual(['a', 'b']);
    expect(openFieldIds(doc({}))).toEqual(['a', 'c', 'b']);
  });
});
