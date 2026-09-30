import {
  mergeImportedEntries,
  parseGlossaryDelimited,
  serializeGlossaryCsv,
} from '@/lib/utils/shared/translation/glossaryCsv';

import { describe, expect, it } from 'vitest';

describe('parseGlossaryDelimited', () => {
  it('reads the two-column Azure glossary format positionally', () => {
    const result = parseGlossaryDelimited('IDP,PDI\nclinic,clinique\n', 100);
    expect(result.entries).toEqual([
      { source: 'IDP', target: 'PDI', kind: 'acronym' },
      { source: 'clinic', target: 'clinique', kind: 'term' },
    ]);
    expect(result.skipped).toBe(0);
  });

  it('maps columns by header name in any order, case-insensitively', () => {
    const text =
      'Target,Note,Source,Kind,sourceExpansion\nPDI,people,IDP,acronym,Internally displaced person\n';
    const { entries } = parseGlossaryDelimited(text, 100);
    expect(entries).toEqual([
      {
        source: 'IDP',
        target: 'PDI',
        kind: 'acronym',
        note: 'people',
        sourceExpansion: 'Internally displaced person',
      },
    ]);
  });

  it('auto-detects tabs, strips a BOM, and honours quoted delimiters', () => {
    const text = '﻿source\ttarget\n"a, b"\t"c ""d"""\n';
    const { entries } = parseGlossaryDelimited(text, 100);
    expect(entries).toEqual([
      { source: 'a, b', target: 'c "d"', kind: 'term' },
    ]);
  });

  it('handles newlines inside quoted cells', () => {
    const text = 'source,target,note\na,b,"line one\nline two"\n';
    const { entries } = parseGlossaryDelimited(text, 100);
    expect(entries[0].note).toBe('line one line two');
  });

  it('skips rows missing a term and counts rows past the ceiling', () => {
    const text = 'a,b\n,x\nc,\nd,e\nf,g\n';
    const result = parseGlossaryDelimited(text, 2);
    expect(result.entries.map((e) => e.source)).toEqual(['a', 'd']);
    expect(result.skipped).toBe(2);
    expect(result.truncated).toBe(1);
  });

  it('drops over-long terms instead of silently truncating them', () => {
    const long = 'x'.repeat(201);
    const result = parseGlossaryDelimited(`${long},y\nok,fine\n`, 100);
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('ignores expansions on term entries and unknown kinds', () => {
    const text = 'source,target,kind,sourceExpansion\nfoo,bar,weird,Full\n';
    const { entries } = parseGlossaryDelimited(text, 100);
    expect(entries).toEqual([{ source: 'foo', target: 'bar', kind: 'term' }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseGlossaryDelimited('', 10)).toEqual({
      entries: [],
      skipped: 0,
      truncated: 0,
    });
  });
});

describe('serializeGlossaryCsv', () => {
  it('round-trips through the parser', () => {
    const entries = [
      {
        source: 'WHO',
        target: 'OMS',
        kind: 'acronym' as const,
        note: 'agency, "UN"',
        sourceExpansion: 'World Health Organization',
        targetExpansion: 'Organisation mondiale de la Santé',
      },
      { source: 'clinic', target: 'clinique', kind: 'term' as const },
    ];
    const csv = serializeGlossaryCsv(entries);
    expect(parseGlossaryDelimited(csv, 100).entries).toEqual(entries);
  });

  it('neutralizes formula triggers so spreadsheets never evaluate a term', () => {
    const csv = serializeGlossaryCsv([
      { source: '=SUM(A1)', target: '+1', kind: 'term' },
    ]);
    expect(csv).toContain("'=SUM(A1),'+1");
  });
});

describe('mergeImportedEntries', () => {
  it('replaces same-source entries case-insensitively and appends the rest', () => {
    const result = mergeImportedEntries(
      [
        { source: 'IDP', target: 'old' },
        { source: 'clinic', target: 'clinique' },
      ],
      [
        { source: 'idp', target: 'new' },
        { source: 'nurse', target: 'infirmier' },
      ],
    );
    expect(result.replaced).toBe(1);
    expect(result.added).toBe(1);
    expect(result.entries.map((e) => `${e.source}=${e.target}`)).toEqual([
      'idp=new',
      'clinic=clinique',
      'nurse=infirmier',
    ]);
  });
});
