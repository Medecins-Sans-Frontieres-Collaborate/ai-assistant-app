/**
 * Series colours for the dashboard charts.
 *
 * Not hand-picked: this is a fixed-order categorical palette validated — by
 * script, for both themes, against THIS app's chart surfaces (#ffffff and
 * surface-dark #212121) — for lightness band, chroma, colour-vision-deficiency
 * separation between neighbours (worst adjacent ΔE 9.1 light / 8.4 dark) and
 * contrast. The dark steps are chosen for the dark surface, not flipped.
 *
 * ⚠ ORDER IS THE SAFETY MECHANISM. Assign slots in sequence, never cycle and
 * never skip: neighbours were validated as neighbours. A fifth series is not
 * a fifth colour — fold the tail into `OTHER`.
 *
 * Aqua and yellow sit below 3:1 on the light surface. That is allowed only
 * because every chart here ships direct labels or a table view; do not use
 * them where a value is readable by colour alone.
 *
 * Literal class strings so Tailwind's scanner sees them.
 */
export interface SeriesColor {
  fill: string;
  stroke: string;
  swatch: string;
}

export const SERIES: readonly SeriesColor[] = [
  {
    fill: 'fill-[#2a78d6] dark:fill-[#3987e5]',
    stroke: 'stroke-[#2a78d6] dark:stroke-[#3987e5]',
    swatch: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  },
  {
    fill: 'fill-[#eb6834] dark:fill-[#d95926]',
    stroke: 'stroke-[#eb6834] dark:stroke-[#d95926]',
    swatch: 'bg-[#eb6834] dark:bg-[#d95926]',
  },
  {
    fill: 'fill-[#1baf7a] dark:fill-[#199e70]',
    stroke: 'stroke-[#1baf7a] dark:stroke-[#199e70]',
    swatch: 'bg-[#1baf7a] dark:bg-[#199e70]',
  },
  {
    fill: 'fill-[#eda100] dark:fill-[#c98500]',
    stroke: 'stroke-[#eda100] dark:stroke-[#c98500]',
    swatch: 'bg-[#eda100] dark:bg-[#c98500]',
  },
];

/** Most series a chart may carry as distinct colours. */
export const MAX_SERIES = SERIES.length;

/** "Everything else", and anything that is context rather than the subject. */
export const OTHER: SeriesColor = {
  fill: 'fill-gray-400 dark:fill-gray-500',
  stroke: 'stroke-gray-400 dark:stroke-gray-500',
  swatch: 'bg-gray-400 dark:bg-gray-500',
};

/**
 * Below a baseline. Paired with slot 1 (blue) above it: a warm and a cool
 * pole, which read as opposite. Only for polarity — never as "series 5".
 */
export const NEGATIVE: SeriesColor = {
  fill: 'fill-[#e34948] dark:fill-[#e66767]',
  stroke: 'stroke-[#e34948] dark:stroke-[#e66767]',
  swatch: 'bg-[#e34948] dark:bg-[#e66767]',
};

/** Chart furniture: recessive, solid hairlines. */
export const GRID = 'stroke-gray-200 dark:stroke-gray-700';
export const BASELINE = 'stroke-gray-300 dark:stroke-gray-600';
export const AXIS_TEXT = 'fill-gray-500 dark:fill-gray-400';
/** The card a chart sits on; also the gap between touching marks. */
export const SURFACE_STROKE = 'stroke-white dark:stroke-surface-dark';
