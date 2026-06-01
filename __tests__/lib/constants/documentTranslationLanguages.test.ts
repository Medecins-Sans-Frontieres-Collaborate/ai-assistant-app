import { isOfficiallySupportedDocumentTranslationLanguage } from '@/lib/constants/documentTranslationLanguages';
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
});
