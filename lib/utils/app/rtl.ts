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
