const GOOD_TEXT_CHARS =
  /[\p{L}\p{N}\p{M}.,;:!?'"()[\]{}\-–—/\\%&+*=<>@#$€£§°_|~^`«»‘’“”•·]/u;

function withoutPageMarkers(text: string): string {
  return text.replace(/^--- Page \d+ ---\r?$/gm, '');
}

/**
 * Detects unusable glyph output in extracted PDF text, ignoring generated
 * page markers. Accepts Unicode prose, numbers and punctuation. Short text
 * is rejected only when it contains no recognizable characters.
 * @param text - Extracted or cached plain text.
 * @returns Whether the text is garbled; does not throw.
 */
export function looksLikeGarbledText(text: string): boolean {
  const chars = Array.from(withoutPageMarkers(text).replace(/\s+/g, ''));
  let good = 0;
  let replacement = 0;
  for (const ch of chars) {
    if (ch === '\uFFFD') replacement += 1;
    else if (GOOD_TEXT_CHARS.test(ch)) good += 1;
  }
  if (chars.length < 40) return chars.length > 0 && good === 0;
  if (replacement / chars.length > 0.05) return true;
  return good / chars.length < 0.6;
}

/**
 * Applies the same PDF text gate to fresh extraction and cached text.
 * @param text - Plain text, optionally containing generated page markers.
 * @returns True if nonblank, nongarbled content remains; does not throw.
 */
export function hasUsablePdfText(text: string): boolean {
  return !!withoutPageMarkers(text).trim() && !looksLikeGarbledText(text);
}
