import {
  getAutonym,
  getSupportedLocales,
  localeToAutonym,
} from '@/lib/utils/app/locales';

import { describe, expect, it } from 'vitest';

describe('locales', () => {
  describe('localeToAutonym', () => {
    it('contains all expected locales', () => {
      const expectedLocales = [
        'am',
        'ar',
        'bn',
        'ca',
        'cs',
        'de',
        'el',
        'en',
        'es',
        'fa',
        'ff',
        'fi',
        'fr',
        'ha',
        'he',
        'hi',
        'ht',
        'id',
        'it',
        'ja',
        'km',
        'ko',
        'ku',
        'ln',
        'mg',
        'my',
        'ne',
        'nl',
        'ny',
        'pl',
        'ps',
        'pt',
        'rn',
        'ro',
        'ru',
        'rw',
        'sg',
        'si',
        'so',
        'sr',
        'sv',
        'sw',
        'ta',
        'te',
        'tg',
        'th',
        'ti',
        'tr',
        'uk',
        'ur',
        'vi',
        'yo',
        'zh',
        'zu',
      ];

      expectedLocales.forEach((locale) => {
        expect(localeToAutonym).toHaveProperty(locale);
        expect(typeof localeToAutonym[locale]).toBe('string');
        expect(localeToAutonym[locale].length).toBeGreaterThan(0);
      });
    });

    it('maps common languages correctly', () => {
      expect(localeToAutonym['en']).toBe('English');
      expect(localeToAutonym['es']).toBe('Español');
      expect(localeToAutonym['fr']).toBe('Français');
      expect(localeToAutonym['de']).toBe('Deutsch');
      expect(localeToAutonym['it']).toBe('Italiano');
      expect(localeToAutonym['pt']).toBe('Português');
      expect(localeToAutonym['ru']).toBe('Русский');
      expect(localeToAutonym['ja']).toBe('日本語');
      expect(localeToAutonym['ko']).toBe('한국어');
      expect(localeToAutonym['zh']).toBe('中文');
    });

    it('uses native scripts for non-Latin languages', () => {
      // Arabic
      expect(localeToAutonym['ar']).toBe('العربية');
      expect(localeToAutonym['ar']).toMatch(/[\u0600-\u06FF]/);

      // Hebrew
      expect(localeToAutonym['he']).toBe('עברית');
      expect(localeToAutonym['he']).toMatch(/[\u0590-\u05FF]/);

      // Thai
      expect(localeToAutonym['th']).toBe('ไทย');
      expect(localeToAutonym['th']).toMatch(/[\u0E00-\u0E7F]/);

      // Amharic
      expect(localeToAutonym['am']).toBe('አማርኛ');
      expect(localeToAutonym['am']).toMatch(/[\u1200-\u137F]/);
    });

    it('contains 33 locales', () => {
      expect(Object.keys(localeToAutonym).length).toBe(54);
    });
  });

  describe('getAutonym', () => {
    describe('Supported Locales', () => {
      it('returns autonym for English', () => {
        expect(getAutonym('en')).toBe('English');
      });

      it('returns autonym for Spanish', () => {
        expect(getAutonym('es')).toBe('Español');
      });

      it('returns autonym for French', () => {
        expect(getAutonym('fr')).toBe('Français');
      });

      it('returns autonym for German', () => {
        expect(getAutonym('de')).toBe('Deutsch');
      });

      it('returns autonym for Japanese', () => {
        expect(getAutonym('ja')).toBe('日本語');
      });

      it('returns autonym for Chinese', () => {
        expect(getAutonym('zh')).toBe('中文');
      });

      it('returns autonym for Arabic', () => {
        expect(getAutonym('ar')).toBe('العربية');
      });

      it('returns autonym for Russian', () => {
        expect(getAutonym('ru')).toBe('Русский');
      });

      it('returns autonym for Hindi', () => {
        expect(getAutonym('hi')).toBe('हिन्दी');
      });

      it('returns autonym for Portuguese', () => {
        expect(getAutonym('pt')).toBe('Português');
      });

      it('works for all supported locales', () => {
        const supportedLocales = Object.keys(localeToAutonym);

        supportedLocales.forEach((locale) => {
          const autonym = getAutonym(locale);
          expect(autonym).toBe(localeToAutonym[locale]);
          expect(typeof autonym).toBe('string');
          expect(autonym.length).toBeGreaterThan(0);
        });
      });
    });

    describe('Unsupported Locales', () => {
      it('returns locale code for unsupported locale', () => {
        expect(getAutonym('xx')).toBe('xx');
        expect(getAutonym('zz')).toBe('zz');
        expect(getAutonym('unsupported')).toBe('unsupported');
      });

      it('handles empty string', () => {
        expect(getAutonym('')).toBe('');
      });

      it('handles locale with country code', () => {
        expect(getAutonym('en-US')).toBe('en-US');
        expect(getAutonym('es-MX')).toBe('es-MX');
      });

      it('is case sensitive', () => {
        expect(getAutonym('EN')).toBe('EN'); // Uppercase not supported
        expect(getAutonym('En')).toBe('En'); // Mixed case not supported
      });

      it('handles numeric input as string', () => {
        expect(getAutonym('123')).toBe('123');
      });

      it('handles special characters', () => {
        expect(getAutonym('en-GB')).toBe('en-GB');
        expect(getAutonym('es_MX')).toBe('es_MX');
      });
    });

    describe('Edge Cases', () => {
      it('handles very long strings', () => {
        const longString = 'a'.repeat(1000);
        expect(getAutonym(longString)).toBe(longString);
      });

      it('handles strings with spaces', () => {
        expect(getAutonym('en us')).toBe('en us');
      });

      it('handles strings with special characters', () => {
        expect(getAutonym('en@US')).toBe('en@US');
        expect(getAutonym('es#MX')).toBe('es#MX');
      });
    });

    describe('Return Type', () => {
      it('always returns a string', () => {
        expect(typeof getAutonym('en')).toBe('string');
        expect(typeof getAutonym('unsupported')).toBe('string');
        expect(typeof getAutonym('')).toBe('string');
      });
    });
  });

  describe('getSupportedLocales', () => {
    it('returns an array', () => {
      const locales = getSupportedLocales();
      expect(Array.isArray(locales)).toBe(true);
    });

    it('returns correct number of locales', () => {
      const locales = getSupportedLocales();
      expect(locales.length).toBe(54);
    });

    it('contains all expected locales', () => {
      const locales = getSupportedLocales();

      expect(locales).toContain('en');
      expect(locales).toContain('es');
      expect(locales).toContain('fr');
      expect(locales).toContain('de');
      expect(locales).toContain('it');
      expect(locales).toContain('pt');
      expect(locales).toContain('ja');
      expect(locales).toContain('ko');
      expect(locales).toContain('zh');
      expect(locales).toContain('ar');
      expect(locales).toContain('ru');
    });

    it('returns same locales as keys in localeToAutonym', () => {
      const locales = getSupportedLocales();
      const expectedLocales = Object.keys(localeToAutonym);

      expect(locales.sort()).toEqual(expectedLocales.sort());
    });

    it('returns only 2-letter locale codes', () => {
      const locales = getSupportedLocales();

      locales.forEach((locale) => {
        expect(locale.length).toBe(2);
        expect(locale).toMatch(/^[a-z]{2}$/);
      });
    });

    it('does not contain duplicates', () => {
      const locales = getSupportedLocales();
      const uniqueLocales = [...new Set(locales)];

      expect(locales.length).toBe(uniqueLocales.length);
    });

    it('returns consistent result on multiple calls', () => {
      const first = getSupportedLocales();
      const second = getSupportedLocales();

      expect(first).toEqual(second);
    });

    it('contains lowercase locale codes only', () => {
      const locales = getSupportedLocales();

      locales.forEach((locale) => {
        expect(locale).toBe(locale.toLowerCase());
        expect(locale).not.toMatch(/[A-Z]/);
      });
    });

    describe('Common Language Checks', () => {
      it('includes major European languages', () => {
        const locales = getSupportedLocales();

        expect(locales).toContain('en'); // English
        expect(locales).toContain('es'); // Spanish
        expect(locales).toContain('fr'); // French
        expect(locales).toContain('de'); // German
        expect(locales).toContain('it'); // Italian
        expect(locales).toContain('pt'); // Portuguese
        expect(locales).toContain('pl'); // Polish
        expect(locales).toContain('nl'); // Dutch
        expect(locales).toContain('sv'); // Swedish
        expect(locales).toContain('fi'); // Finnish
      });

      it('includes major Asian languages', () => {
        const locales = getSupportedLocales();

        expect(locales).toContain('zh'); // Chinese
        expect(locales).toContain('ja'); // Japanese
        expect(locales).toContain('ko'); // Korean
        expect(locales).toContain('hi'); // Hindi
        expect(locales).toContain('bn'); // Bengali
        expect(locales).toContain('th'); // Thai
        expect(locales).toContain('vi'); // Vietnamese
        expect(locales).toContain('id'); // Indonesian
      });

      it('includes major Middle Eastern languages', () => {
        const locales = getSupportedLocales();

        expect(locales).toContain('ar'); // Arabic
        expect(locales).toContain('fa'); // Persian
        expect(locales).toContain('he'); // Hebrew
        expect(locales).toContain('tr'); // Turkish
        expect(locales).toContain('ur'); // Urdu
      });

      it('includes other notable languages', () => {
        const locales = getSupportedLocales();

        expect(locales).toContain('ru'); // Russian
        expect(locales).toContain('uk'); // Ukrainian
        expect(locales).toContain('ro'); // Romanian
        expect(locales).toContain('cs'); // Czech
        expect(locales).toContain('ca'); // Catalan
        expect(locales).toContain('sw'); // Swahili
        expect(locales).toContain('am'); // Amharic
        expect(locales).toContain('my'); // Burmese
        expect(locales).toContain('si'); // Sinhala
        expect(locales).toContain('te'); // Telugu
      });

      it('includes MSF operational languages', () => {
        const locales = getSupportedLocales();

        expect(locales).toContain('so'); // Somali
        expect(locales).toContain('ti'); // Tigrinya
        expect(locales).toContain('ps'); // Pashto
        expect(locales).toContain('ha'); // Hausa
        expect(locales).toContain('ln'); // Lingala
        expect(locales).toContain('km'); // Khmer
        expect(locales).toContain('ne'); // Nepali
        expect(locales).toContain('rw'); // Kinyarwanda
        expect(locales).toContain('ta'); // Tamil
        expect(locales).toContain('rn'); // Kirundi
        expect(locales).toContain('ht'); // Haitian Creole
        expect(locales).toContain('yo'); // Yoruba
        expect(locales).toContain('ff'); // Fulah
        expect(locales).toContain('ny'); // Chichewa
        expect(locales).toContain('mg'); // Malagasy
        expect(locales).toContain('ku'); // Kurdish
        expect(locales).toContain('zu'); // Zulu
        expect(locales).toContain('sg'); // Sango (CAR)
        expect(locales).toContain('el'); // Greek
        expect(locales).toContain('tg'); // Tajik
        expect(locales).toContain('sr'); // Serbian
      });
    });
  });

  describe('Integration', () => {
    it('getAutonym and getSupportedLocales are consistent', () => {
      const locales = getSupportedLocales();

      locales.forEach((locale) => {
        const autonym = getAutonym(locale);
        expect(autonym).toBe(localeToAutonym[locale]);
        expect(autonym).not.toBe(locale); // Should return native name, not code
      });
    });

    it('all autonyms are non-empty strings', () => {
      const locales = getSupportedLocales();

      locales.forEach((locale) => {
        const autonym = getAutonym(locale);
        expect(typeof autonym).toBe('string');
        expect(autonym.length).toBeGreaterThan(0);
      });
    });

    it('can iterate through all locales and get autonyms', () => {
      const locales = getSupportedLocales();
      const autonyms: string[] = [];

      locales.forEach((locale) => {
        autonyms.push(getAutonym(locale));
      });

      expect(autonyms.length).toBe(locales.length);
      expect(autonyms.every((a) => typeof a === 'string')).toBe(true);
    });
  });
});
