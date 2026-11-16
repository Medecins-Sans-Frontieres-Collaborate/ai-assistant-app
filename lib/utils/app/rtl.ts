/**
 * RTL (Right-to-Left) language utilities.
 * Provides functions to detect and handle RTL locales.
 */

/** Locales that use right-to-left text direction */
export const RTL_LOCALES = ['ar', 'he', 'fa', 'ps', 'ur'] as const;

export type RTLLocale = (typeof RTL_LOCALES)[number];

/**
 * Check if a locale uses right-to-left text direction.
 * @param locale - The locale code to check (e.g., 'ar', 'en')
 * @returns true if the locale is RTL, false otherwise
 */
export function isRTL(locale: string): boolean {
  return RTL_LOCALES.includes(locale as RTLLocale);
}

/**
 * Get the text direction for a locale.
 * @param locale - The locale code (e.g., 'ar', 'en')
 * @returns 'rtl' for RTL locales, 'ltr' for LTR locales
 */
export function getDirection(locale: string): 'rtl' | 'ltr' {
  return isRTL(locale) ? 'rtl' : 'ltr';
}

/**
 * Get the text direction of any language, not only the app's UI locales.
 *
 * Uses the runtime's CLDR data, so languages the UI is not translated into
 * (Dari, Sorani, Uyghur, …) resolve correctly; falls back to RTL_LOCALES when
 * the code is not a valid language tag or the runtime has no text info.
 *
 * @param languageCode - BCP 47 language tag (e.g., 'ar', 'prs', 'zh-Hans')
 * @returns 'rtl' or 'ltr'
 */
export function getLanguageDirection(languageCode: string): 'rtl' | 'ltr' {
  try {
    const locale = new Intl.Locale(languageCode).maximize() as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction;
    if (direction === 'rtl' || direction === 'ltr') return direction;
  } catch {
    // Not a valid language tag: fall through to the static list.
  }
  return getDirection(languageCode.split('-')[0]);
}
