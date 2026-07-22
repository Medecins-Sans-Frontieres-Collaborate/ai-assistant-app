/**
 * Shared series palette for multi-series charts. Literal Tailwind class
 * strings (JIT-safe); the first entry matches the existing single-series
 * blue so unsplit charts stay visually identical.
 */

export interface SeriesColor {
  fill: string;
  stroke: string;
  swatch: string;
}

export const SERIES_COLORS: readonly SeriesColor[] = [
  {
    fill: 'fill-blue-500/80 dark:fill-blue-400/70',
    stroke: 'stroke-blue-500 dark:stroke-blue-400',
    swatch: 'bg-blue-500 dark:bg-blue-400',
  },
  {
    fill: 'fill-amber-500/80 dark:fill-amber-400/70',
    stroke: 'stroke-amber-500 dark:stroke-amber-400',
    swatch: 'bg-amber-500 dark:bg-amber-400',
  },
  {
    fill: 'fill-emerald-500/80 dark:fill-emerald-400/70',
    stroke: 'stroke-emerald-500 dark:stroke-emerald-400',
    swatch: 'bg-emerald-500 dark:bg-emerald-400',
  },
  {
    fill: 'fill-violet-500/80 dark:fill-violet-400/70',
    stroke: 'stroke-violet-500 dark:stroke-violet-400',
    swatch: 'bg-violet-500 dark:bg-violet-400',
  },
  {
    fill: 'fill-rose-500/80 dark:fill-rose-400/70',
    stroke: 'stroke-rose-500 dark:stroke-rose-400',
    swatch: 'bg-rose-500 dark:bg-rose-400',
  },
  {
    fill: 'fill-cyan-500/80 dark:fill-cyan-400/70',
    stroke: 'stroke-cyan-500 dark:stroke-cyan-400',
    swatch: 'bg-cyan-500 dark:bg-cyan-400',
  },
];

/** Pass as maxSeries to the split aggregate helpers. */
export const MAX_SERIES = SERIES_COLORS.length;
