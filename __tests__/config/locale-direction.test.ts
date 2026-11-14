import { getSupportedLocales, isRtlLocale } from '@/lib/utils/app/locales';

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Letters of right-to-left scripts: Hebrew, Arabic (with its supplements and
 * presentation forms), Syriac, Thaana and N'Ko.
 */
const RTL_LETTER = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;

/** Any letter, in any script. */
const ANY_LETTER = /\p{L}/gu;

/**
 * A translation counts as right-to-left when most of its letters are. Real
 * files sit far from this line (about 0.8 and above, or about 0), so the
 * exact value only has to separate the two groups.
 */
const RTL_MAJORITY = 0.5;

/** Every translated string in a locale file, placeholders removed. */
function collectText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\{[^}]*\}/g, '');
  if (value && typeof value === 'object') {
    return Object.values(value).map(collectText).join(' ');
  }
  return '';
}

/**
 * Share of a locale file's letters that belong to a right-to-left script.
 *
 * @param locale - Locale code naming a file in /messages.
 * @returns A number from 0 to 1.
 */
function rtlLetterShare(locale: string): number {
  const file = path.join(process.cwd(), 'messages', `${locale}.json`);
  const text = collectText(JSON.parse(fs.readFileSync(file, 'utf-8')));
  const letters = text.match(ANY_LETTER)?.length ?? 0;
  const rtlLetters = text.match(RTL_LETTER)?.length ?? 0;
  return letters === 0 ? 0 : rtlLetters / letters;
}

/**
 * The page direction is decided by a list of locale codes (RTL_LOCALES). This
 * suite derives the expected answer from the translations themselves, so a
 * locale written in a right-to-left script can never be left out of the list
 * (or a left-to-right one added to it) without a failure here.
 */
describe('page direction matches the script each locale is written in', () => {
  const locales = getSupportedLocales();

  it.each(locales)('%s', (locale) => {
    const writtenRightToLeft = rtlLetterShare(locale) > RTL_MAJORITY;
    expect(isRtlLocale(locale)).toBe(writtenRightToLeft);
  });

  it('covers both directions, so the rule is exercised on each side', () => {
    const rightToLeft = locales.filter(isRtlLocale);
    expect(rightToLeft.length).toBeGreaterThan(0);
    expect(rightToLeft.length).toBeLessThan(locales.length);
  });

  it('has a translation file for every supported locale', () => {
    for (const locale of locales) {
      expect(
        fs.existsSync(path.join(process.cwd(), 'messages', `${locale}.json`)),
      ).toBe(true);
    }
  });
});
