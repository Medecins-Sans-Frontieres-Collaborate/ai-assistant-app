import { MapFeature } from '@/types/workflow';

/**
 * Category filtering for map features. Categories are free-form model
 * strings ("hospital", "Hospital", "field hospital"), so filtering works
 * on normalized keys while chips display the most common original
 * spelling. The tail beyond the chip cap (and empty categories) rolls
 * into one "Other" bucket.
 */

export const MAX_CATEGORY_CHIPS = 8;
export const OTHER_CATEGORY_KEY = '__other__';

/** trim, unicode-normalize, lowercase, collapse internal whitespace. */
export function normalizeCategoryKey(raw: string | undefined): string {
  return (raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export interface CategoryChip {
  key: string;
  label: string;
  count: number;
}

export function buildCategoryChips(features: MapFeature[]): {
  /** Top categories by count, plus a trailing "other" chip when non-empty. */
  chips: CategoryChip[];
  /** Keys that got their own chip (excludes the other-key). */
  chipKeys: Set<string>;
} {
  const groups = new Map<
    string,
    { count: number; spellings: Map<string, number> }
  >();

  let uncategorized = 0;
  for (const feature of features) {
    const key = normalizeCategoryKey(feature.category);
    if (!key) {
      uncategorized += 1;
      continue;
    }
    const group = groups.get(key) ?? { count: 0, spellings: new Map() };
    group.count += 1;
    const spelling = feature.category.trim();
    group.spellings.set(spelling, (group.spellings.get(spelling) ?? 0) + 1);
    groups.set(key, group);
  }

  const ranked = [...groups.entries()]
    .map(([key, group]) => {
      // Label = most frequent original spelling (ties: first inserted).
      let label = key;
      let best = 0;
      for (const [spelling, count] of group.spellings) {
        if (count > best) {
          best = count;
          label = spelling;
        }
      }
      return { key, label, count: group.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const chips = ranked.slice(0, MAX_CATEGORY_CHIPS);
  const chipKeys = new Set(chips.map((c) => c.key));

  const otherCount =
    ranked.slice(MAX_CATEGORY_CHIPS).reduce((sum, c) => sum + c.count, 0) +
    uncategorized;

  return {
    chips:
      otherCount > 0
        ? [...chips, { key: OTHER_CATEGORY_KEY, label: '', count: otherCount }]
        : chips,
    chipKeys,
  };
}

/**
 * Whether a feature passes the active category filter. Empty active set =
 * no filtering. The OTHER key matches features whose normalized category
 * is empty or didn't earn a chip.
 */
export function featureMatchesCategories(
  feature: MapFeature,
  active: Set<string>,
  chipKeys: Set<string>,
): boolean {
  if (active.size === 0) return true;
  const key = normalizeCategoryKey(feature.category);
  if (key && chipKeys.has(key)) return active.has(key);
  return active.has(OTHER_CATEGORY_KEY);
}
