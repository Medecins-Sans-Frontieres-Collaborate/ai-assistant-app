/**
 * Removes diacritical marks (accents) from a string.
 *
 * Decomposes characters into base letter + combining marks (NFD), then strips
 * the combining marks. Safe for non-Latin scripts: CJK characters are
 * unaffected, and Arabic harakat are removed (which is desirable for search).
 *
 * @param input - The text to strip diacritics from
 * @returns The text with diacritical marks removed
 *
 * @example
 * stripDiacritics("Español") // "Espanol"
 * stripDiacritics("néerlandais") // "neerlandais"
 */
export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Normalizes a string for case- and accent-insensitive search comparison.
 *
 * @param input - The text to normalize
 * @returns Lowercased text with diacritical marks removed
 *
 * @example
 * normalizeForSearch("Español") // "espanol"
 */
export function normalizeForSearch(input: string): string {
  return stripDiacritics(input).toLowerCase();
}
