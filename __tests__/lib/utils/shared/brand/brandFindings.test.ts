import {
  BrandFinding,
  groupFindings,
} from '@/lib/utils/shared/brand/brandFindings';

import { describe, expect, it } from 'vitest';

/** Findings as problems: what is one problem, and what is not. */

function finding(changes: Partial<BrandFinding>): BrandFinding {
  return {
    id: 'f',
    rule: 'font',
    severity: 'error',
    page: 1,
    unitId: null,
    imageId: null,
    box: null,
    found: 'Arial',
    expected: ['Avenir Next'],
    source: 'check',
    ...changes,
  };
}

describe('groupFindings', () => {
  it('makes one problem of the same rule and values, in report order', () => {
    const groups = groupFindings([
      finding({ id: 'b', page: 2 }),
      finding({ id: 'c', page: 1, found: 'Calibri' }),
      finding({ id: 'a', page: 1, found: 'ARIAL' }),
    ]);
    expect(groups.map((g) => g.findings.map((f) => f.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('keeps apart what differs in rule, value or what to use instead', () => {
    const groups = groupFindings([
      finding({ id: 'a' }),
      finding({ id: 'b', rule: 'banned-term' }),
      finding({ id: 'c', expected: ['Bitter'] }),
      finding({ id: 'd', found: 'Arial Narrow' }),
    ]);
    expect(groups).toHaveLength(4);
  });

  it('never merges the model’s findings: their notes differ', () => {
    const groups = groupFindings([
      finding({ id: 'a', rule: 'tone', source: 'model', note: 'One.' }),
      finding({ id: 'b', rule: 'tone', source: 'model', note: 'Two.' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});
