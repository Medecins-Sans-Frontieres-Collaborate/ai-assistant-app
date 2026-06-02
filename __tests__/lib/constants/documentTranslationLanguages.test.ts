import {
  isOfficiallySupportedDocumentTranslationLanguage,
  searchDocumentTranslationLanguages,
} from '@/lib/constants/documentTranslationLanguages';
import { describe, expect, it } from 'vitest';

describe('documentTranslationLanguages', () => {
  describe('isOfficiallySupportedDocumentTranslationLanguage', () => {
    it('returns true for a known officially supported language', () => {
      expect(isOfficiallySupportedDocumentTranslationLanguage('en')).toBe(true);
    });

    it('returns false for a known unofficial language', () => {
      expect(isOfficiallySupportedDocumentTranslationLanguage('fa')).toBe(
        false,
      );
    });

    it('returns false for an unknown language code', () => {
      expect(isOfficiallySupportedDocumentTranslationLanguage('xx')).toBe(
        false,
      );
    });

    it('matches codes case-insensitively', () => {
      // 'zh-Hans' is officially supported regardless of input casing
      expect(isOfficiallySupportedDocumentTranslationLanguage('ZH-HANS')).toBe(
        true,
      );
    });
  });

  describe('searchDocumentTranslationLanguages', () => {
    const codesFor = (query: string, locale?: string): string[] =>
      searchDocumentTranslationLanguages(query, locale).map((l) => l.code);

    it('returns the full list for an empty query', () => {
      expect(searchDocumentTranslationLanguages('').length).toBeGreaterThan(50);
    });

    it('finds Persian by its common alias "Farsi"', () => {
      expect(codesFor('farsi')).toContain('fa');
    });

    it('finds Chinese by its alias "Mandarin" (case-insensitive)', () => {
      expect(codesFor('MANDARIN')).toContain('zh-Hans');
    });

    it('finds Dutch by its alias "Flemish"', () => {
      expect(codesFor('flemish')).toContain('nl');
    });

    it('matches accent-insensitively (autonym "Español" via "espanol")', () => {
      expect(codesFor('espanol')).toContain('es');
    });

    it('still matches the native autonym directly', () => {
      expect(codesFor('فارسی')).toContain('fa');
    });

    it('returns nothing for a query that matches no language', () => {
      expect(searchDocumentTranslationLanguages('zzzznotalanguage')).toEqual(
        [],
      );
    });
  });
});
