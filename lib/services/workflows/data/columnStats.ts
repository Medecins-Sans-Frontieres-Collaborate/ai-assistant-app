import { ColumnProfile, DataColumn } from '@/types/workflow';

import { formatCell } from './tableUtils';

/**
 * Deterministic per-column profiling, computed client-side in a single
 * pass over the rows. This is the exact counterpart to the LLM quality
 * assessment: anything countable (missing %, distinct values, ranges) is
 * computed here and fed to prompts as ground truth, never rated by the
 * model. Client-safe (no server imports); also feeds the rail digest.
 */

/** Top-value tables are only meaningful for low-cardinality columns. */
export const TOP_VALUES_MAX_DISTINCT = 20;

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function finalizeNumbers(profile: ColumnProfile, numbers: number[]): void {
  if (numbers.length === 0) return;
  numbers.sort((a, b) => a - b);
  profile.min = numbers[0];
  profile.max = numbers[numbers.length - 1];
  profile.mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  const mid = Math.floor(numbers.length / 2);
  profile.median =
    numbers.length % 2 === 1
      ? numbers[mid]
      : (numbers[mid - 1] + numbers[mid]) / 2;
}

export function profileColumn(
  column: DataColumn,
  rows: Record<string, unknown>[],
): ColumnProfile {
  const profile: ColumnProfile = {
    columnId: column.id,
    total: rows.length,
    missing: 0,
    distinct: 0,
  };
  const counts = new Map<string, number>();
  const numbers: number[] = [];
  let minDate: string | undefined;
  let maxDate: string | undefined;

  for (const row of rows) {
    const value = row[column.id];
    if (isMissing(value)) {
      profile.missing += 1;
      continue;
    }
    const formatted = formatCell(value);
    counts.set(formatted, (counts.get(formatted) ?? 0) + 1);
    if (column.type === 'number' && typeof value === 'number') {
      numbers.push(value);
    } else if (column.type === 'date') {
      // Imported dates are normalized toward ISO 8601, where
      // lexicographic order is chronological order.
      if (minDate === undefined || formatted < minDate) minDate = formatted;
      if (maxDate === undefined || formatted > maxDate) maxDate = formatted;
    }
  }

  profile.distinct = counts.size;
  finalizeNumbers(profile, numbers);
  if (column.type === 'date') {
    profile.minDate = minDate;
    profile.maxDate = maxDate;
  }
  if (
    (column.type === 'text' || column.type === 'boolean') &&
    counts.size > 0 &&
    counts.size <= TOP_VALUES_MAX_DISTINCT
  ) {
    // ALL distinct values, sorted by count — the profile popover shows
    // the head; value-set filters and the chat digest use the full list.
    profile.topValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
  }
  return profile;
}

export function profileTable(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
): Map<string, ColumnProfile> {
  const profiles = new Map<string, ColumnProfile>();
  for (const column of columns) {
    profiles.set(column.id, profileColumn(column, rows));
  }
  return profiles;
}
