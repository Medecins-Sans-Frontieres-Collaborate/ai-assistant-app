/** Number formatting shared by every dashboard chart. */

/**
 * 1,284 · 19,029 · 217.1K · 4.2M — for tiles, axis ticks and bar tips. Five
 * digits are still read at a glance, so they are kept: "19,029" says more
 * than "19K".
 */
export function formatCompact(value: number, locale: string): string {
  const abs = Math.abs(value);
  if (abs < 100_000) {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: abs < 10 ? 2 : abs < 100 ? 1 : 0,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/** An axis tick: short, so the axis stays narrow — 500 · 2,000 · 20K · 1.5M. */
export function formatTick(value: number, locale: string): string {
  if (Math.abs(value) < 10_000) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
      value,
    );
  }
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/** The full figure — for tooltips, the table view, and money. */
export function formatFull(value: number, locale: string): string {
  // A difference of two equal floats is -0 or 1e-13, never "−0".
  const clean = Math.abs(value) < 5e-7 ? 0 : value;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    clean,
  );
}

/**
 * Round axis maximum (1, 2, 2.5, 5 × 10ⁿ) at or above the data, and the tick
 * step that divides it into `ticks` equal parts.
 */
export function niceScale(
  max: number,
  ticks = 4,
): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 / ticks };
  const rough = max / ticks;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ??
    10 * power;
  return { max: step * ticks, step };
}

export type TableCell = string | number | null;

export interface ChartTable {
  columns: string[];
  rows: TableCell[][];
}
