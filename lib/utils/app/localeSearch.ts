/**
 * Normalize a string for locale-aware substring search.
 *
 * Folds case in a locale-sensitive way (e.g. Turkish İ/ı) and strips
 * diacritics (café ↔ cafe) so filtering matches the way users actually type
 * across the app's 33 locales. Apply to both the query and the candidate
 * before comparing with `includes`.
 */
export function normalizeForSearch(value: string, locale?: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase(locale)
    .trim();
}
