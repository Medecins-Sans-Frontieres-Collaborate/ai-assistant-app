import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
  findTranslationLanguageByLabel,
  translatedFileName,
  translatedFileSuffix,
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

describe('findTranslationLanguageByLabel', () => {
  it('knows a listed language by any of its names', () => {
    for (const label of [
      'German (Deutsch)',
      'german',
      'Deutsch',
      'de',
      ' German ',
    ]) {
      expect(findTranslationLanguageByLabel(label)?.id, label).toBe('de');
    }
    expect(findTranslationLanguageByLabel('Haitian Creole')?.id).toBe('ht');
  });

  it('does not guess at a language typed in by hand', () => {
    for (const label of ['Patwah', 'German (Swiss)', 'Germ', '']) {
      expect(findTranslationLanguageByLabel(label), label).toBeUndefined();
    }
  });
});

describe('translated file names', () => {
  it('carries a listed language as its code', () => {
    expect(translatedFileSuffix('German (Deutsch)')).toBe('de');
    expect(translatedFileSuffix('french')).toBe('fr');
    expect(translatedFileName('Report 2026.pdf', 'French', 'pdf')).toBe(
      'Report 2026_fr.pdf',
    );
    expect(translatedFileName('Report 2026.pdf', 'Spanish', 'pptx')).toBe(
      'Report 2026_es.pptx',
    );
  });

  it('carries a language typed in by hand as a slug of its name', () => {
    expect(translatedFileSuffix('Patwah')).toBe('patwah');
    expect(translatedFileSuffix(' Haitian Creole (North) ')).toBe(
      'haitian-creole-north',
    );
    expect(translatedFileName('notes.pdf', 'Patwah', 'pdf')).toBe(
      'notes_patwah.pdf',
    );
  });

  it('still names the file when the language name leaves no slug', () => {
    expect(translatedFileSuffix('中文方言')).toBe('translated');
    expect(translatedFileSuffix('')).toBe('translated');
  });

  it('keeps dots that are part of the name, and names with no extension', () => {
    expect(translatedFileName('v1.2 final.pdf', 'French', 'pdf')).toBe(
      'v1.2 final_fr.pdf',
    );
    expect(translatedFileName('minutes', 'French', 'pdf')).toBe(
      'minutes_fr.pdf',
    );
  });
});
