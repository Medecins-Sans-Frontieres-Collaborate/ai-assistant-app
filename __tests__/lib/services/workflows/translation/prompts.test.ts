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
