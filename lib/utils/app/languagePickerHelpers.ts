/**
 * A language option rendered by the shared `<LanguagePicker>` component.
 *
 * This type is intentionally decoupled from any particular backend's language
 * list — callers convert their own catalog (Whisper, Azure Translator, app
 * locales, etc.) into `LanguageOption[]` and pass it in.
 */
export interface LanguageOption {
  /** Stable identifier (ISO 639-1, BCP-47, or the empty string when caller uses clearOption instead). */
  code: string;
  /** Primary row text. Typically the autonym or the localized English name. */
  label: string;
  /** Secondary, dimmed row text. Typically the locale code or the English name. */
  sublabel?: string;
  /** When false, the row is rendered with a muted style (unofficial / lower-quality). */
  supported?: boolean;
}

/**
 * Case-insensitive substring filter over `label`, `sublabel`, and `code`.
 * Empty / whitespace-only queries return the original list unchanged.
 *
 * One deliberate ranking rule: a two-character query that exactly matches an
 * option's code promotes that option to the top — someone typing "de" or
 * "es" means the ISO code, and the alphabetical order would otherwise bury
 * it under substring matches (e.g. "es" inside "Burmese"). Exactly two
 * characters only; every other query keeps the input order.
 */
export function filterLanguageOptions(
  options: LanguageOption[],
  query: string,
): LanguageOption[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return options;
  const filtered = options.filter((opt) => {
    if (opt.label.toLowerCase().includes(trimmed)) return true;
    if (opt.sublabel && opt.sublabel.toLowerCase().includes(trimmed))
      return true;
    if (opt.code.toLowerCase().includes(trimmed)) return true;
    return false;
  });
  if (trimmed.length === 2) {
    const exactIndex = filtered.findIndex(
      (opt) => opt.code.toLowerCase() === trimmed,
    );
    if (exactIndex > 0) {
      const [exact] = filtered.splice(exactIndex, 1);
      filtered.unshift(exact);
    }
  }
  return filtered;
}

/**
 * Sort a list of language options alphabetically by `label` using locale-aware
 * collation. Does not mutate the input.
 */
export function sortLanguageOptionsByLabel(
  options: LanguageOption[],
): LanguageOption[] {
  return [...options].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}
