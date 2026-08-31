/**
 * An option rendered by the shared `<SearchableListPicker>` component.
 * Deliberately minimal — callers map their own domain objects (folders,
 * agents, …) into this shape.
 */
export interface SearchableListOption {
  /** Stable identifier returned from `onSelect`. */
  id: string;
  /** Primary row text. */
  label: string;
  /** Secondary, dimmed row text. */
  sublabel?: string;
}

/**
 * Case-insensitive substring filter over `label` and `sublabel`. Empty or
 * whitespace-only queries return the original list unchanged (same array,
 * so memoised callers don't re-render).
 */
export function filterSearchableOptions<T extends SearchableListOption>(
  options: T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return options;
  return options.filter(
    (opt) =>
      opt.label.toLowerCase().includes(trimmed) ||
      (opt.sublabel?.toLowerCase().includes(trimmed) ?? false),
  );
}

/**
 * True when the trimmed query is non-trivial and matches no option label
 * exactly (case-insensitive) — i.e. offering to create it makes sense.
 */
export function shouldOfferCreate(
  options: SearchableListOption[],
  query: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 1) return false;
  const lower = trimmed.toLowerCase();
  return !options.some((opt) => opt.label.toLowerCase() === lower);
}
