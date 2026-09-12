/**
 * Language naming for the form workflow. Detection returns ISO 639-1 codes;
 * the ledger, prompts and provenance document use English language names
 * ("French"), which is what the document workflow's profile call returns
 * too. Client-safe; `Intl.DisplayNames` exists in every supported runtime.
 */

let displayNames: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (displayNames !== undefined) return displayNames;
  try {
    displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    displayNames = null;
  }
  return displayNames;
}

/** "fr" → "French"; unknown or empty codes return undefined. */
export function languageNameFromCode(
  code: string | undefined,
): string | undefined {
  const trimmed = code?.trim().toLowerCase();
  if (!trimmed || trimmed === 'unknown' || trimmed === 'und') return undefined;
  try {
    const name = names()?.of(trimmed);
    if (!name || name === trimmed) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

/** A short curated list for the language picker; any name may be typed. */
export const COMMON_LANGUAGES = [
  'English',
  'French',
  'Spanish',
  'Arabic',
  'Portuguese',
  'German',
  'Italian',
  'Dutch',
  'Russian',
  'Ukrainian',
  'Chinese',
  'Japanese',
  'Korean',
  'Hindi',
  'Bengali',
  'Urdu',
  'Farsi',
  'Turkish',
  'Swahili',
  'Amharic',
  'Somali',
  'Hausa',
  'Indonesian',
  'Vietnamese',
  'Thai',
  'Polish',
  'Greek',
  'Hebrew',
] as const;
