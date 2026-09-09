import { canAccessProcurement } from '@/lib/services/rfp/access';
import {
  allCriteria,
  loadSpec,
  questionCompare,
  questionIds,
} from '@/lib/services/rfp/criteria';
import { isValidRunId, rfpRunDir } from '@/lib/services/rfp/runPaths';
import {
  containment,
  looksLikeStub,
  normForMatch,
} from '@/lib/services/rfp/stages/extractResponses';

import { describe, expect, it } from 'vitest';

const SPEC_INPUT = {
  questions: {
    '1': 'First?',
    '2': 'Second?',
    '10': 'Tenth?',
    '12': 'Twelfth?',
    '12a': 'Sub a?',
  },
  categories: [
    {
      num: 1,
      name: 'Cat A',
      criteria: [
        { name: 'C1', questions: [1, '12a'], weight: 0.5 },
        { name: 'C2', questions: ['10'], weight: 0.5 },
      ],
    },
  ],
};

describe('criteria', () => {
  it('sorts question ids naturally', () => {
    expect(['12a', '2', '12', '1', '10'].sort(questionCompare)).toEqual([
      '1',
      '2',
      '10',
      '12',
      '12a',
    ]);
  });

  it('normalizes mixed int/string question references to strings', () => {
    const spec = loadSpec(SPEC_INPUT);
    expect(allCriteria(spec)[0][2].questions).toEqual(['1', '12a']);
    expect(questionIds(spec)).toEqual(['1', '2', '10', '12', '12a']);
  });

  it('rejects weights that do not sum to 1.0', () => {
    const bad = JSON.parse(JSON.stringify(SPEC_INPUT));
    bad.categories[0].criteria[0].weight = 0.4;
    expect(() => loadSpec(bad)).toThrow(/sum to 1\.0/);
  });

  it('rejects references to unknown questions', () => {
    const bad = JSON.parse(JSON.stringify(SPEC_INPUT));
    bad.categories[0].criteria[0].questions = ['99z'];
    expect(() => loadSpec(bad)).toThrow(/unknown question/);
  });
});

describe('runPaths', () => {
  it('accepts UUIDs and rejects traversal attempts', () => {
    expect(isValidRunId('02b30849-db91-4617-9dd9-e42e1a425977')).toBe(true);
    expect(isValidRunId('../../etc/passwd')).toBe(false);
    expect(isValidRunId('02b30849')).toBe(false);
    expect(() => rfpRunDir('../escape')).toThrow(/Invalid run id/);
  });
});

describe('extraction quality checks', () => {
  it('flags empty answers and in-document pointers as stubs', () => {
    expect(looksLikeStub('')).toBe(true);
    expect(looksLikeStub('(RESPONSES BEGIN ON THE NEXT PAGE)')).toBe(true);
    expect(
      looksLikeStub('See the example included in the following 8 pages.'),
    ).toBe(true);
  });

  it('flags answers truncated at a page footer, regardless of length', () => {
    expect(looksLikeStub(`${'A long answer. '.repeat(50)}Page 33 of 85`)).toBe(
      true,
    );
  });

  it('does not flag legitimate short answers', () => {
    expect(looksLikeStub('2009')).toBe(false);
    expect(looksLikeStub('Yes, we comply with all standard terms.')).toBe(
      false,
    );
  });

  it('measures verbatim containment against source text', () => {
    const source = normForMatch(
      'Our approach begins with a detailed analysis of the donor file.',
    );
    const spaceless = source.replace(/ /g, '');
    expect(
      containment(
        'Our approach begins with a detailed analysis',
        source,
        spaceless,
      ),
    ).toBe(1);
    expect(
      containment(
        'Completely fabricated text never in the source doc',
        source,
        spaceless,
      ),
    ).toBe(0);
  });

  it('tolerates PDF hyphenation artifacts via spaceless matching', () => {
    const answer = 'well-established repeatable process';
    const source = normForMatch('well- established repeatable process'); // line-break hyphenation
    expect(containment(answer, source, source.replace(/ /g, ''))).toBe(1);
  });
});

describe('procurement access control', () => {
  it('allows the allowlisted users by email or display name', () => {
    expect(
      canAccessProcurement({ mail: 'christopher.graham@newyork.msf.org' }),
    ).toBe(true);
    expect(canAccessProcurement({ mail: 'Arthi.Nithi@newyork.msf.org' })).toBe(
      true,
    );
    expect(canAccessProcurement({ displayName: 'Arthi Nithi' })).toBe(true);
    expect(canAccessProcurement({ displayName: 'Christopher Graham' })).toBe(
      true,
    );
  });

  it('denies everyone else', () => {
    expect(canAccessProcurement(null)).toBe(false);
    expect(canAccessProcurement({})).toBe(false);
    expect(canAccessProcurement({ mail: 'someone.else@newyork.msf.org' })).toBe(
      false,
    );
    expect(canAccessProcurement({ displayName: 'Some One' })).toBe(false);
  });
});
