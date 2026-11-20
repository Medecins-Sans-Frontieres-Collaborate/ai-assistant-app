import {
  buildTermsPrompt,
  targetLanguageLines,
} from '@/lib/services/documentTranslation/native/nativePdfPrompts';

import { describe, expect, it } from 'vitest';

describe('targetLanguageLines', () => {
  it('names only the label when nothing is settled', () => {
    expect(targetLanguageLines('Patwah', undefined)).toBe(
      'Target language: Patwah',
    );
  });

  it('adds what the brief settled, once, on its own line', () => {
    expect(
      targetLanguageLines('Patwah', {
        code: 'jam',
        name: 'Jamaican Patois',
        note: 'Cassidy-JLU spelling.',
      }),
    ).toBe(
      [
        'Target language: Patwah (Jamaican Patois, jam)',
        'Write every unit in this variety and spelling, as every other page does: Cassidy-JLU spelling.',
      ].join('\n'),
    );
  });

  it('does not repeat a name that is the label', () => {
    expect(
      targetLanguageLines('German', { code: 'de', name: 'german', note: '' }),
    ).toBe('Target language: German (de)');
    expect(
      targetLanguageLines('German', { code: '', name: 'German', note: '' }),
    ).toBe('Target language: German');
  });
});

describe('buildTermsPrompt', () => {
  it('carries the person’s additions after the rules', () => {
    const plain = buildTermsPrompt(undefined);
    const steered = buildTermsPrompt('Keep all project names in English.');
    expect(steered.startsWith(plain)).toBe(true);
    expect(steered).toContain('Keep all project names in English.');
    expect(buildTermsPrompt('')).toBe(plain);
  });
});
