import {
  blockingCount,
  runChecks,
} from '@/lib/utils/shared/review/deterministicChecks';
import {
  glossaryDeterministicCheck,
  glossaryViolationsAsFindings,
} from '@/lib/utils/shared/translation/glossaryDeterministicCheck';
import { checkGlossaryCompliance } from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const entries: GlossaryEntry[] = [
  { source: 'cholera', target: 'choléra' },
  {
    source: 'WHO',
    target: 'OMS',
    sourceExpansion: 'World Health Organization',
    targetExpansion: 'Organisation mondiale de la Santé',
  },
];

describe('glossaryDeterministicCheck', () => {
  it('reports nothing when every required term is present', () => {
    const findings = runChecks([glossaryDeterministicCheck], {
      entries,
      sourceText: 'Cholera cases reported by the WHO.',
      translation: 'Cas de choléra signalés par l’OMS.',
    });
    expect(findings).toEqual([]);
  });

  it('turns each violation into one blocking finding that keeps its detail', () => {
    const findings = runChecks([glossaryDeterministicCheck], {
      entries,
      sourceText: 'Cholera cases reported by the WHO.',
      translation: 'Cas de choléra signalés par l’oms.',
    });
    expect(findings).toEqual([
      {
        checkId: 'glossary',
        severity: 'block',
        messageKey: 'glossaryTermMissing',
        values: {
          source: 'WHO',
          target: 'OMS',
          kind: 'acronym',
          matchedBy: 'source',
        },
      },
    ]);
    expect(blockingCount(findings)).toBe(1);
  });

  it('never disagrees with the scan it wraps', () => {
    const sourceText = 'Cholera and the WHO.';
    const translation = 'Rien du tout.';
    const scan = checkGlossaryCompliance(entries, sourceText, translation);
    expect(
      glossaryDeterministicCheck.run({ entries, sourceText, translation }),
    ).toEqual(glossaryViolationsAsFindings(scan.violations));
    expect(scan.violations.length).toBeGreaterThan(0);
  });
});
