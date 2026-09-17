import {
  checkGlossaryCompliance,
  findMatchingEntries,
  isAcronymLike,
  resolveEntryKind,
  sanitizeGlossaryEntry,
  sortLongestFirst,
  termOccursIn,
} from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

/**
 * Issue #131 regression suite: capitalization variants, overlapping
 * multi-word entries, and acronyms must all be matched — and later
 * verified — consistently.
 */
describe('glossaryMatch', () => {
  describe('isAcronymLike / resolveEntryKind', () => {
    it('detects initialisms by shape', () => {
      for (const t of ['WHO', 'MSF', 'H5N1', 'U.N.', 'MSF-OCA', 'COVID-19']) {
        expect(isAcronymLike(t), t).toBe(true);
      }
      for (const t of ['A', 'Mr', 'iPhone', 'cholera', 'Who', 'WHOLESALER1']) {
        expect(isAcronymLike(t), t).toBe(false);
      }
    });

    it('an explicit kind always wins over the shape', () => {
      expect(
        resolveEntryKind({ source: 'who', target: 'x', kind: 'acronym' }),
      ).toBe('acronym');
      expect(
        resolveEntryKind({ source: 'WHO', target: 'x', kind: 'term' }),
      ).toBe('term');
      expect(resolveEntryKind({ source: 'WHO', target: 'x' })).toBe('acronym');
      expect(resolveEntryKind({ source: 'cholera', target: 'x' })).toBe('term');
    });
  });

  describe('termOccursIn', () => {
    it('matches terms on whole words regardless of capitalization', () => {
      const opts = { caseSensitive: false };
      expect(termOccursIn('The Cholera outbreak', 'cholera', opts)).toBe(true);
      expect(termOccursIn('CHOLERA OUTBREAK', 'cholera', opts)).toBe(true);
      expect(termOccursIn('cholera-like', 'cholera', opts)).toBe(true);
      // Substrings of other words are NOT matches.
      expect(termOccursIn('the category list', 'cat', opts)).toBe(false);
      expect(termOccursIn('WHOLESALE prices', 'who', opts)).toBe(false);
    });

    it('is Unicode-aware at word boundaries', () => {
      const opts = { caseSensitive: false };
      expect(
        termOccursIn("l'hôpital de campagne", 'hôpital de campagne', opts),
      ).toBe(true);
      // A long continuation is still inside the word (two trailing letters
      // of inflection are tolerated, three are not).
      expect(termOccursIn('hôpitalisé', 'hôpital', opts)).toBe(false);
      expect(termOccursIn('hôpitalé', 'hôpital', opts)).toBe(true);
      expect(
        termOccursIn("l'OMS a publié", 'OMS', { caseSensitive: true }),
      ).toBe(true);
    });

    it('matches multi-word phrases across whitespace runs and line wraps', () => {
      expect(
        termOccursIn('a field\n  hospital opened', 'field hospital', {
          caseSensitive: false,
        }),
      ).toBe(true);
    });

    it('acronyms: WHO matches "the WHO issued" but never "Davis, who is"', () => {
      const opts = { caseSensitive: true };
      expect(termOccursIn('The WHO issued a report.', 'WHO', opts)).toBe(true);
      expect(
        termOccursIn('Davis, who is the medical operator, said…', 'WHO', opts),
      ).toBe(false);
      expect(termOccursIn('Who is eligible?', 'WHO', opts)).toBe(false);
      expect(termOccursIn('WHOLESALE', 'WHO', opts)).toBe(false);
    });

    it('acronyms: an occurrence inside a shouting heading does not count (source side)', () => {
      const opts = { caseSensitive: true, ignoreShouting: true };
      expect(
        termOccursIn('WHO IS ELIGIBLE FOR CARE\n\nBody text.', 'WHO', opts),
      ).toBe(false);
      // …but a real mention elsewhere in the same text still does.
      expect(
        termOccursIn(
          'WHO IS ELIGIBLE\n\nThe WHO issued guidance.',
          'WHO',
          opts,
        ),
      ).toBe(true);
      // Two-word all-caps lines are not headings ("WHO REPORT" is a title).
      expect(termOccursIn('WHO REPORT', 'WHO', opts)).toBe(true);
    });

    it('tolerates inflection on the tail only', () => {
      const term = { caseSensitive: false };
      expect(
        termOccursIn('two field hospitals opened', 'field hospital', term),
      ).toBe(true);
      expect(termOccursIn('des choléras', 'choléra', term)).toBe(true);
      expect(termOccursIn('the category', 'cat', term)).toBe(false);
      expect(termOccursIn('unhospitable', 'hospital', term)).toBe(false);
      const acr = { caseSensitive: true };
      expect(termOccursIn('several NGOs and the NGO’s staff', 'NGO', acr)).toBe(
        true,
      );
      expect(termOccursIn("the NGO's staff", 'NGO', acr)).toBe(true);
      expect(termOccursIn('NGOS', 'NGO', acr)).toBe(false);
      expect(termOccursIn('WHOLESALE', 'WHO', acr)).toBe(false);
    });

    it('the shouting filter is opt-in and never applied to the output check', () => {
      expect(
        termOccursIn('RAPPORT DE L’OMS SUR LE CHOLÉRA', 'OMS', {
          caseSensitive: true,
        }),
      ).toBe(true);
      expect(
        termOccursIn('RAPPORT DE L’OMS SUR LE CHOLÉRA', 'OMS', {
          caseSensitive: true,
          ignoreShouting: true,
        }),
      ).toBe(false);
      // …and a translation whose only OMS is in a heading still passes.
      expect(
        checkGlossaryCompliance(
          [{ source: 'WHO', target: 'OMS' }],
          'The WHO report on cholera.',
          'RAPPORT DE L’OMS SUR LE CHOLÉRA\n\nTexte.',
        ).violations,
      ).toEqual([]);
    });

    it('escapes regex metacharacters in terms', () => {
      expect(
        termOccursIn('see U.N. report', 'U.N.', { caseSensitive: true }),
      ).toBe(true);
      expect(
        termOccursIn('see UXNX report', 'U.N.', { caseSensitive: true }),
      ).toBe(false);
      expect(
        termOccursIn('cost (USD)', '(USD)', { caseSensitive: false }),
      ).toBe(true);
    });
  });

  describe('findMatchingEntries', () => {
    const entries: GlossaryEntry[] = [
      { source: 'health', target: 'santé' },
      { source: 'health promotion', target: 'promotion de la santé' },
      {
        source: 'WHO',
        target: 'OMS',
        sourceExpansion: 'World Health Organization',
      },
      { source: 'who', target: 'qui', kind: 'term' },
      { source: 'cat', target: 'chat' },
    ];

    it('keeps original order and reports how each entry matched', () => {
      const matched = findMatchingEntries(
        entries,
        'Health Promotion is a WHO priority for the category.',
      );
      // The lowercase TERM entry "who" matches any capitalization, so it
      // also fires on "WHO" — the inverse ambiguity the editor warns about.
      expect(matched.map((m) => m.entry.source)).toEqual([
        'health',
        'health promotion',
        'WHO',
        'who',
      ]);
      expect(matched.map((m) => m.kind)).toEqual([
        'term',
        'term',
        'acronym',
        'term',
      ]);
      expect(matched[2].matchedBy).toBe('source');
    });

    it('pulls an acronym entry in by its full name', () => {
      const matched = findMatchingEntries(
        entries,
        'The World Health Organization issued guidance.',
      );
      expect(matched.map((m) => m.entry.source)).toEqual(['health', 'WHO']);
      expect(matched[1].matchedBy).toBe('expansion');
    });

    it('lowercase "who" hits the term entry, not the acronym', () => {
      const matched = findMatchingEntries(
        entries,
        'Davis, who is the operator',
      );
      expect(matched.map((m) => m.entry.source)).toEqual(['who']);
    });

    it('drops incomplete entries', () => {
      expect(findMatchingEntries([{ source: 'x', target: ' ' }], 'x')).toEqual(
        [],
      );
    });
  });

  describe('sortLongestFirst', () => {
    it('orders overlapping phrases longest first, stably', () => {
      const sorted = sortLongestFirst([
        { entry: { source: 'health', target: 'a' } },
        { entry: { source: 'health promotion', target: 'b' } },
        { entry: { source: 'cholera', target: 'c' } },
        { entry: { source: 'field hospital', target: 'd' } },
      ]);
      expect(sorted.map((m) => m.entry.source)).toEqual([
        'health promotion',
        'field hospital',
        'cholera',
        'health',
      ]);
    });
  });

  describe('checkGlossaryCompliance', () => {
    const entries: GlossaryEntry[] = [
      { source: 'cholera', target: 'choléra' },
      {
        source: 'WHO',
        target: 'OMS',
        sourceExpansion: 'World Health Organization',
        targetExpansion: 'Organisation mondiale de la Santé',
      },
      { source: 'MSF', target: 'MSF' },
    ];

    it('passes when every required translation is present (any case for terms)', () => {
      const result = checkGlossaryCompliance(
        entries,
        'Cholera cases reported by the WHO and MSF.',
        'Cas de CHOLÉRA signalés par l’OMS et MSF.',
      );
      expect(result.checkedTerms).toBe(3);
      expect(result.violations).toEqual([]);
    });

    it('flags a missing term and a lowercased acronym', () => {
      const result = checkGlossaryCompliance(
        entries,
        'Cholera cases reported by the WHO.',
        'Cas de choléra signalés par l’oms.',
      );
      expect(result.violations).toEqual([
        { source: 'WHO', target: 'OMS', kind: 'acronym', matchedBy: 'source' },
      ]);
    });

    it('accepts the full-name translation for an acronym', () => {
      const result = checkGlossaryCompliance(
        entries,
        'The WHO issued guidance.',
        "L'Organisation mondiale de la Santé a publié des directives.",
      );
      expect(result.violations).toEqual([]);
    });

    it('enforces keep-verbatim entries (target equals source)', () => {
      const result = checkGlossaryCompliance(
        entries,
        'MSF opened a clinic.',
        'Médecins Sans Frontières a ouvert une clinique.',
      );
      expect(result.violations.map((v) => v.source)).toEqual(['MSF']);
    });

    it('checks nothing when no entry occurs in the source', () => {
      expect(checkGlossaryCompliance(entries, 'Hello', 'Bonjour')).toEqual({
        checkedTerms: 0,
        violations: [],
      });
    });
  });

  describe('sanitizeGlossaryEntry', () => {
    it('trims, caps, collapses whitespace, validates kind and drops junk', () => {
      expect(
        sanitizeGlossaryEntry({ source: 'field\n  hospital', target: 'x' }),
      ).toEqual({ source: 'field hospital', target: 'x' });
      expect(
        sanitizeGlossaryEntry({
          source: '  WHO ',
          target: ' OMS ',
          note: 'x',
          kind: 'acronym',
          sourceExpansion: ' World Health Organization ',
          targetExpansion: 42,
        }),
      ).toEqual({
        source: 'WHO',
        target: 'OMS',
        note: 'x',
        kind: 'acronym',
        sourceExpansion: 'World Health Organization',
      });
      expect(
        sanitizeGlossaryEntry({ source: 'x', target: 'y', kind: 'bogus' }),
      ).toEqual({ source: 'x', target: 'y' });
      expect(sanitizeGlossaryEntry({ source: 'x', target: '' })).toBeNull();
      expect(sanitizeGlossaryEntry('nope')).toBeNull();
      expect(sanitizeGlossaryEntry(null)).toBeNull();
      const long = sanitizeGlossaryEntry({
        source: 'a'.repeat(999),
        target: 'b',
      });
      expect(long?.source.length).toBe(200);
    });
  });
});

describe('findMatchingEntries pre-filter', () => {
  it('still matches across a line wrap and under one-way case folding', () => {
    const entries = [
      { source: 'internally displaced', target: 'déplacé interne' },
      { source: 'staff', target: 'personnel' },
      { source: 'Kelvin', target: 'kelvin' },
    ];
    // Line wrap inside the phrase; long s (U+017F) and Kelvin sign
    // (U+212A) fold onto plain letters under the regex's `iu` flag.
    const text = 'Many internally\ndisplaced ſtaff measured \u212Aelvin.';
    const matched = findMatchingEntries(entries, text).map(
      (m) => m.entry.source,
    );
    expect(matched).toEqual(['internally displaced', 'staff', 'Kelvin']);
  });

  it('stays linear on a large glossary with few hits', () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => ({
      source: `term${i}`,
      target: `x${i}`,
    }));
    entries.push({ source: 'needle', target: 'aiguille' });
    const text = `${'hay '.repeat(15_000)}needle`;
    const started = performance.now();
    const matched = findMatchingEntries(entries, text);
    expect(matched.map((m) => m.entry.source)).toEqual(['needle']);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
