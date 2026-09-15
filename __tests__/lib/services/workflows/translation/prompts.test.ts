import { mergeGlossaryEntries } from '@/lib/services/workflows/shared/glossaryPrompts';
import {
  analysisToNotes,
  buildGlossaryBlock,
  buildTranslationSystemPrompt,
} from '@/lib/services/workflows/translation/prompts';

import { describe, expect, it } from 'vitest';

describe('translation glossary prompt injection', () => {
  const entries = [
    { source: 'cholera', target: 'choléra' },
    {
      source: 'field hospital',
      target: 'hôpital de campagne',
      note: 'MSF usage',
    },
    { source: 'unrelated term', target: 'terme inutile' },
  ];

  it('includes only entries that occur in the source text (case-insensitive)', () => {
    const block = buildGlossaryBlock(
      entries,
      'The Cholera outbreak reached the field hospital.',
    );
    expect(block).toContain('cholera');
    expect(block).toContain('choléra');
    expect(block).toContain('hôpital de campagne');
    expect(block).toContain('MSF usage');
    expect(block).not.toContain('terme inutile');
  });

  it('returns an empty string when nothing matches', () => {
    expect(buildGlossaryBlock(entries, 'No relevant words here')).toBe('');
  });

  it('drops incomplete entries', () => {
    const block = buildGlossaryBlock(
      [{ source: 'cholera', target: '' }],
      'cholera',
    );
    expect(block).toBe('');
  });

  it('lands the glossary block in the translation system prompt', () => {
    const block = buildGlossaryBlock(entries, 'cholera');
    const system = buildTranslationSystemPrompt(block);
    expect(system).toContain('MANDATORY TERMINOLOGY');
    expect(system).toContain('Output ONLY the translation');
  });
});

describe('analysisToNotes', () => {
  it('compacts analysis into prompt notes', () => {
    const notes = analysisToNotes({
      trickyTerms: [
        {
          term: 'triage',
          issue: 'no direct equivalent',
          suggestion: 'keep French',
        },
      ],
      ambiguities: [{ text: 'the mission', readings: ['MSF mission', 'trip'] }],
      register: 'formal',
      notes: 'Audience is donors.',
    });
    expect(notes).toContain('Register: formal');
    expect(notes).toContain('triage');
    expect(notes).toContain('MSF mission / trip');
    expect(notes).toContain('Audience is donors.');
  });
});

describe('translation glossary prompt injection — issue #131', () => {
  it('matches capitalization variants of a term: lower, Title, UPPER', () => {
    const entries = [{ source: 'cholera', target: 'choléra' }];
    for (const text of ['cholera spread', 'Cholera spread', 'CHOLERA SPREAD']) {
      expect(buildGlossaryBlock(entries, text), text).toContain('choléra');
    }
  });

  it('does not match a term inside another word', () => {
    expect(
      buildGlossaryBlock([{ source: 'cat', target: 'chat' }], 'the category'),
    ).toBe('');
  });

  it('renders overlapping multi-word entries longest first and states the rule', () => {
    const block = buildGlossaryBlock(
      [
        { source: 'health', target: 'santé' },
        { source: 'health promotion', target: 'promotion de la santé' },
      ],
      'Health promotion matters.',
    );
    expect(block.indexOf('| health promotion |')).toBeLessThan(
      block.indexOf('| health |'),
    );
    expect(block).toContain('longest matching phrase wins');
  });

  it('acronyms: WHO is injected for "the WHO", not for "who is", and is marked case-sensitive', () => {
    const entries = [
      {
        source: 'WHO',
        target: 'OMS',
        sourceExpansion: 'World Health Organization',
        targetExpansion: 'Organisation mondiale de la Santé',
      },
    ];
    const hit = buildGlossaryBlock(entries, 'The WHO issued a report.');
    expect(hit).toContain('| WHO | OMS |');
    expect(hit).toContain('case-sensitive');
    expect(hit).toContain(
      'World Health Organization → Organisation mondiale de la Santé',
    );
    expect(
      buildGlossaryBlock(entries, 'Davis, who is the medical operator.'),
    ).toBe('');
  });

  it('the budget truncates in original (priority) order before sorting', () => {
    const entries = [
      { source: 'aa', target: '1' }, // admin's most important row first
      { source: 'a much longer phrase', target: '2' },
    ];
    const block = buildGlossaryBlock(
      entries,
      'aa and a much longer phrase',
      20, // only the first row fits
    );
    expect(block).toContain('| aa | 1 |');
    expect(block).not.toContain('a much longer phrase');
  });

  it('escapes pipes for markdown without changing the required value', () => {
    const block = buildGlossaryBlock(
      [{ source: 'a|b', target: 'c|d' }],
      'see a|b here',
    );
    expect(block).toContain('| a\\|b | c\\|d |');
    // The model still reads the literal target the checker will look for.
    expect(block).not.toContain('c/d');
  });

  it('escapes backslashes before pipes so a trailing backslash cannot un-escape a pipe', () => {
    const block = buildGlossaryBlock(
      [{ source: 'a\\|b', target: 'c\\d' }],
      'see a\\|b here',
    );
    expect(block).toContain('| a\\\\\\|b | c\\\\d |');
  });

  it('mergeGlossaryEntries: org entry wins across case, but an explicit word beside an acronym survives', () => {
    const merged = mergeGlossaryEntries(
      [{ source: 'IDP', target: 'personne déplacée' }],
      [
        { source: 'idp', target: 'déplacé interne' }, // duplicate → dropped
        { source: 'WHO', target: 'OMS' },
        { source: 'who', target: 'qui', kind: 'term' }, // distinct word → kept
        { source: 'who', target: 'lequel', kind: 'term' }, // second one → dropped
      ],
    );
    expect(merged).toEqual([
      { source: 'IDP', target: 'personne déplacée' },
      { source: 'WHO', target: 'OMS' },
      { source: 'who', target: 'qui', kind: 'term' },
    ]);
  });
});
