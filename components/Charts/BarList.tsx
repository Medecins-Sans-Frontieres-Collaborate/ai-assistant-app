'use client';

import { FC } from 'react';

import { useLocale } from 'next-intl';

import { formatCompact, formatFull } from '@/components/Charts/format';
import { NEGATIVE, OTHER, SERIES } from '@/components/Charts/palette';

export interface BarItem {
  label: string;
  value: number;
  /** Drawn in the de-emphasis grey: "everything else", folded groups. */
  muted?: boolean;
}

interface BarListProps {
  items: BarItem[];
  /** Appended to each value at the bar tip ("g", "USD"). */
  unit?: string;
  ariaLabel: string;
}

/**
 * Ranked horizontal bars. Horizontal because the categories here have long
 * names — "Strategy & Organisational Development" does not fit under a
 * column, and a truncated label is a label nobody can read.
 *
 * Built from HTML, not SVG: the label column wraps and sizes itself, which an
 * SVG text element cannot do. One series, so one colour and no legend — the
 * card's title says what is plotted. Every value is written at its bar's tip,
 * so nothing here depends on hovering.
 */
export const BarList: FC<BarListProps> = ({ items, unit, ariaLabel }) => {
  const locale = useLocale();
  const max = Math.max(...items.map((item) => item.value), 0);

  return (
    <ul aria-label={ariaLabel} className="space-y-1.5">
      {items.map((item) => (
        <li
          key={item.label}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 text-sm"
        >
          {/* Up to two lines, then clipped with the full name on hover: the
              reason these bars are horizontal is so names can be read. */}
          <span
            className="line-clamp-2 break-words leading-snug text-gray-700 dark:text-gray-300"
            title={item.label}
          >
            {item.label}
          </span>
          <span className="flex items-center gap-2">
            {/* The track is the plot area; the bar grows from its left edge. */}
            <span className="relative h-3 min-w-0 flex-1">
              <span
                className={`absolute inset-y-0 left-0 rounded-r ${
                  (item.muted ? OTHER : SERIES[0]).swatch
                }`}
                style={{
                  width: `${max > 0 ? Math.max((item.value / max) * 100, 0.5) : 0}%`,
                }}
              />
            </span>
            <span
              className="w-20 shrink-0 text-right tabular-nums text-black dark:text-white"
              title={formatFull(item.value, locale)}
            >
              {formatCompact(item.value, locale)}
              {unit ? ` ${unit}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
};

interface DivergingBarListProps {
  items: BarItem[];
  unit?: string;
  ariaLabel: string;
}

/**
 * Bars either side of a zero line, for a change: increases to the right in
 * blue, decreases to the left in red. The sign is also in the number, so the
 * colour is never the only thing saying which way it went.
 */
export const DivergingBarList: FC<DivergingBarListProps> = ({
  items,
  unit,
  ariaLabel,
}) => {
  const locale = useLocale();
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 0);

  return (
    <ul aria-label={ariaLabel} className="space-y-1.5">
      {items.map((item) => {
        const share = max > 0 ? (Math.abs(item.value) / max) * 50 : 0;
        const positive = item.value >= 0;
        return (
          <li
            key={item.label}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 text-sm"
          >
            <span
              className="line-clamp-2 break-words leading-snug text-gray-700 dark:text-gray-300"
              title={item.label}
            >
              {item.label}
            </span>
            <span className="flex items-center gap-2">
              <span className="relative h-3 min-w-0 flex-1">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-[-3px] left-1/2 w-px bg-gray-300 dark:bg-gray-600"
                />
                <span
                  className={`absolute inset-y-0 ${
                    positive
                      ? `left-1/2 rounded-r ${SERIES[0].swatch}`
                      : `right-1/2 rounded-l ${NEGATIVE.swatch}`
                  }`}
                  style={{ width: `${Math.max(share, 0.5)}%` }}
                />
              </span>
              <span
                className="w-24 shrink-0 text-right tabular-nums text-black dark:text-white"
                title={formatFull(item.value, locale)}
              >
                {positive ? '+' : '−'}
                {formatCompact(Math.abs(item.value), locale)}
                {unit ? ` ${unit}` : ''}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
};

/** One item per label, values added — several rows of one group become one bar. */
export function mergeByLabel(items: readonly BarItem[]): BarItem[] {
  const merged = new Map<string, BarItem>();
  for (const item of items) {
    const existing = merged.get(item.label);
    if (existing) existing.value += item.value;
    else merged.set(item.label, { ...item });
  }
  return [...merged.values()];
}

/**
 * The largest `keep` items, with everything after them summed into one muted
 * row — so a long tail does not push the story off the card, and the total
 * still adds up.
 */
export function foldTail(
  items: BarItem[],
  keep: number,
  restLabel: (count: number) => string,
): BarItem[] {
  // Rows that are already "everything else" sink to the bottom on their own.
  const named = items.filter((item) => !item.muted);
  const muted = items.filter((item) => item.muted);
  const sorted = [...named].sort((a, b) => b.value - a.value);
  // A "tail" of one is just the next item: folding it would hide a name to
  // save no space at all.
  if (sorted.length <= keep + 1) return [...sorted, ...muted];
  const rest = sorted.slice(keep);
  return [
    ...sorted.slice(0, keep),
    {
      label: restLabel(rest.length),
      value: rest.reduce((sum, item) => sum + item.value, 0),
      muted: true,
    },
    ...muted,
  ];
}
