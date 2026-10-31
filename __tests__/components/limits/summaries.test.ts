/**
 * components/Limits/summaries.ts — the one-line "applies to" / jurisdiction
 * copy, now with group names when the shared cache knows them.
 */
import { appliesToLine, jurisdictionLine } from '@/components/Limits/summaries';

import { describe, expect, it } from 'vitest';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

const t = (key: string, values?: Record<string, string | number>) => {
  switch (key) {
    case 'appliesTo':
      return `${values?.scope}: ${values?.targets}`;
    case 'appliesToMore':
      return `${values?.targets} and ${values?.more} more`;
    case 'appliesToNone':
      return 'nobody yet';
    case 'jurisdictionGroupCount':
      return `${values?.count} groups`;
    case 'jurisdictionMatchesNobody':
      return 'matches nobody';
    default:
      return key.replace('scope.', '');
  }
};

describe('appliesToLine', () => {
  it('shows group names when known and falls back to the id otherwise', () => {
    expect(appliesToLine(t, 'group', [G1, G2], { [G1]: 'Health' })).toBe(
      `group: Health, ${G2}`,
    );
    expect(appliesToLine(t, 'group', [G1])).toBe(`group: ${G1}`);
  });

  it('never applies group names to other scopes', () => {
    expect(appliesToLine(t, 'user', ['a@x.org'], { 'a@x.org': 'X' })).toBe(
      'user: a@x.org',
    );
  });
});

describe('jurisdictionLine', () => {
  const predicates = [
    { scope: 'domain' as const, targets: ['ocp.msf.org'] },
    { scope: 'group' as const, targets: [G1, G2] },
  ];

  it('lists groups by name when every id is named, counts them otherwise', () => {
    expect(
      jurisdictionLine(t, predicates, { [G1]: 'Health', [G2]: 'Logistics' }),
    ).toBe('domain: ocp.msf.org · group: Health, Logistics');
    expect(jurisdictionLine(t, predicates, { [G1]: 'Health' })).toBe(
      'domain: ocp.msf.org · group: 2 groups',
    );
    expect(jurisdictionLine(t, predicates)).toBe(
      'domain: ocp.msf.org · group: 2 groups',
    );
  });
});
