import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';

import { describe, expect, it } from 'vitest';

describe('translation language catalog', () => {
  it('has unique ids', () => {
    const ids = TRANSLATION_LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers MSF-relevant targets missing from the UI locales', () => {
    for (const id of ['ps', 'prs', 'kmr', 'ckb', 'ti', 'rhg', 'din', 'sg']) {
      expect(findTranslationLanguage(id), `missing ${id}`).toBeDefined();
    }
    expect(findTranslationLanguage('ps')?.name).toBe('Pashto');
    expect(findTranslationLanguage('prs')?.name).toBe('Dari');
  });

  it('is a substantial catalog', () => {
    expect(TRANSLATION_LANGUAGES.length).toBeGreaterThanOrEqual(100);
  });

  it('labels combine name and autonym only when they differ', () => {
    expect(
      translationLanguageLabel({ id: 'ps', name: 'Pashto', autonym: 'پښتو' }),
    ).toBe('Pashto (پښتو)');
    expect(
      translationLanguageLabel({
        id: 'en',
        name: 'English',
        autonym: 'English',
      }),
    ).toBe('English');
  });

  it('every entry has non-empty fields', () => {
    for (const lang of TRANSLATION_LANGUAGES) {
      expect(lang.id.trim()).not.toBe('');
      expect(lang.name.trim()).not.toBe('');
      expect(lang.autonym.trim()).not.toBe('');
    }
  });
});
