import {
  normalizeForSearch,
  stripDiacritics,
} from '@/lib/utils/shared/string/normalizeDiacritics';

import { describe, expect, it } from 'vitest';

describe('normalizeDiacritics', () => {
  describe('stripDiacritics', () => {
    it('removes Latin accents while preserving the base letters', () => {
      expect(stripDiacritics('Español')).toBe('Espanol');
      expect(stripDiacritics('néerlandais')).toBe('neerlandais');
      expect(stripDiacritics('Français')).toBe('Francais');
    });

    it('leaves text without diacritics unchanged', () => {
      expect(stripDiacritics('Persian')).toBe('Persian');
    });

    it('leaves CJK characters untouched', () => {
      expect(stripDiacritics('简体中文')).toBe('简体中文');
      expect(stripDiacritics('日本語')).toBe('日本語');
    });
  });

  describe('normalizeForSearch', () => {
    it('lowercases and strips diacritics', () => {
      expect(normalizeForSearch('Español')).toBe('espanol');
      expect(normalizeForSearch('NÉERLANDAIS')).toBe('neerlandais');
    });
  });
});
