'use client';

import { FC, KeyboardEvent, PointerEvent, useState } from 'react';

import { useLocale } from 'next-intl';

import { formatFull, formatTick, niceScale } from '@/components/Charts/format';
import {
  AXIS_TEXT,
  BASELINE,
  GRID,
  SURFACE_STROKE,
  SeriesColor,
} from '@/components/Charts/palette';
import { useChartWidth } from '@/components/Charts/useChartWidth';

export interface ChartSeries {
  name: string;
  /** One value per category; null = no data there. */
  values: (number | null)[];
  color: SeriesColor;
}

interface TimeChartProps {
  /** `column` with several series stacks them. */
  kind: 'line' | 'column';
  /** The x positions, in order, already formatted for display. */
  categories: string[];
  series: ChartSeries[];
  ariaLabel: string;
  /** Appended to values in the tooltip ("USD", "g"). */
  unit?: string;
  /** Label of the stack total in the tooltip (stacked columns only). */
  totalLabel?: string;
}

const PLOT_HEIGHT = 200;
const MARGIN = { top: 10, right: 12, bottom: 24, left: 50 };
/** Room for a line's name at its right-hand end. */
const END_LABEL_WIDTH = 104;
const MAX_BAR_WIDTH = 24;
const BAR_END_RADIUS = 4;
/** Surface-coloured space between touching marks. */
const GAP = 2;
/** Rough width of an x label, for thinning them out. */
const X_LABEL_WIDTH = 64;
const END_LABEL_MIN_SEPARATION = 14;

/** A column with a rounded data-end and a square foot on the baseline. */
function columnPath(
  x: number,
  y: number,
  width: number,
  height: number,
  rounded: boolean,
): string {
  const r = rounded ? Math.min(BAR_END_RADIUS, width / 2, height) : 0;
  return [
    `M${x},${y + height}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `L${x + width},${y + height}`,
    'Z',
  ].join(' ');
}

/**
 * Values over an ordered axis — days, weeks, months, or ordered bands — as a
 * line or as columns.
 *
 * ONE y axis, always. Two measures on different scales are two charts.
 *
 * Reading a value never requires landing on a mark: the pointer only has to
 * be over the plot, the nearest position is found for it, and one readout
 * lists every series there. The same readout follows the arrow keys when the
 * chart has focus, and every figure is also in the card's table view.
 */
export const TimeChart: FC<TimeChartProps> = ({
  kind,
  categories,
  series,
  ariaLabel,
  unit,
  totalLabel,
}) => {
  const locale = useLocale();
  const { ref, width } = useChartWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const count = categories.length;
  const stacked = kind === 'column' && series.length > 1;

  const totals = categories.map((_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const highest = stacked
    ? Math.max(...totals, 0)
    : Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 0);
  const scale = niceScale(highest);
  const ticks = Array.from({ length: 5 }, (_, i) => i * scale.step);
  const yAt = (value: number) =>
    MARGIN.top + PLOT_HEIGHT - (value / scale.max) * PLOT_HEIGHT;
  const baseline = MARGIN.top + PLOT_HEIGHT;
  const height = baseline + MARGIN.bottom;

  // Names at the ends of lines — only where they would not sit on top of
  // each other. Vertical positions do not depend on the width, so whether
  // they fit is known before the room for them is set aside.
  const lineEnds =
    kind === 'line' && series.length > 1
      ? series
          .map((s) => {
            let last = s.values.length - 1;
            while (last >= 0 && s.values[last] === null) last--;
            return last < 0
              ? null
              : { name: s.name, index: last, y: yAt(s.values[last] as number) };
          })
          .filter(
            (end): end is { name: string; index: number; y: number } => !!end,
          )
          .sort((a, b) => a.y - b.y)
      : [];
  const labelEnds =
    lineEnds.length > 0 &&
    lineEnds.every(
      (end, i) =>
        i === 0 || end.y - lineEnds[i - 1].y >= END_LABEL_MIN_SEPARATION,
    );

  const right = MARGIN.right + (labelEnds ? END_LABEL_WIDTH : 0);
  const plotWidth = Math.max(width - MARGIN.left - right, 40);
  const slot = count > 0 ? plotWidth / count : plotWidth;
  const xAt = (index: number) => MARGIN.left + slot * (index + 0.5);

  const labelEvery = Math.max(
    1,
    Math.ceil((count * X_LABEL_WIDTH) / plotWidth),
  );
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(slot - 2 * GAP, 1));

  const indexAt = (clientX: number, bounds: DOMRect) => {
    // Screen pixels → chart units: they differ until the container has been
    // measured (and for the one frame after it is resized).
    const unit = bounds.width > 0 ? width / bounds.width : 1;
    const x = (clientX - bounds.left) * unit - MARGIN.left;
    return Math.min(count - 1, Math.max(0, Math.floor(x / slot)));
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (count === 0) return;
    setActive(
      indexAt(event.clientX, event.currentTarget.getBoundingClientRect()),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setActive((current) =>
        Math.min(
          count - 1,
          Math.max(0, (current ?? (step > 0 ? -1 : count)) + step),
        ),
      );
    } else if (event.key === 'Escape') {
      setActive(null);
    }
  };

  return (
    <div className="space-y-2">
      {series.length > 1 && (
        // Always present for two or more series: identity is never carried
        // by colour-matching alone.
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`${s.color.swatch} ${
                  kind === 'line' ? 'h-0.5 w-4' : 'h-2.5 w-2.5 rounded-sm'
                }`}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}

      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? count - 1)}
        onBlur={() => setActive(null)}
        className="relative rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <svg
          // Drawn in real pixels once measured; until then the viewBox scales
          // the default width DOWN to the container, so a chart never spills
          // out of its card.
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          className="block touch-none"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={yAt(tick)}
                y2={yAt(tick)}
                strokeWidth={1}
                className={tick === 0 ? BASELINE : GRID}
              />
              <text
                x={MARGIN.left - 8}
                y={yAt(tick) + 4}
                textAnchor="end"
                className={`${AXIS_TEXT} text-[11px] tabular-nums`}
              >
                {formatTick(tick, locale)}
              </text>
            </g>
          ))}

          {categories.map(
            (category, i) =>
              i % labelEvery === 0 && (
                <text
                  key={`${category}-${i}`}
                  x={xAt(i)}
                  y={baseline + 16}
                  textAnchor="middle"
                  className={`${AXIS_TEXT} text-[11px]`}
                >
                  {category}
                </text>
              ),
          )}

          {/* The position being read: a band behind columns, a hairline
              through lines. */}
          {active !== null &&
            (kind === 'column' ? (
              <rect
                x={MARGIN.left + slot * active}
                y={MARGIN.top}
                width={slot}
                height={PLOT_HEIGHT}
                className="fill-gray-100 dark:fill-gray-800"
              />
            ) : (
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={MARGIN.top}
                y2={baseline}
                strokeWidth={1}
                className={BASELINE}
              />
            ))}

          {kind === 'column' &&
            categories.map((_, i) => {
              let top = baseline;
              const present = series.filter((s) => (s.values[i] ?? 0) > 0);
              return present.map((s, position) => {
                const value = s.values[i] as number;
                const full = (value / scale.max) * PLOT_HEIGHT;
                // Each segment above the first gives up GAP px, which shows
                // the surface between it and its neighbour.
                const gap = position === 0 ? 0 : GAP;
                const segmentHeight = Math.max(full - gap, 1);
                const y = top - full;
                top = y;
                return (
                  <path
                    key={`${s.name}-${i}`}
                    d={columnPath(
                      xAt(i) - barWidth / 2,
                      y,
                      barWidth,
                      segmentHeight,
                      position === present.length - 1,
                    )}
                    className={s.color.fill}
                  />
                );
              });
            })}

          {kind === 'line' &&
            series.map((s) => {
              let path = '';
              let pen = false;
              s.values.forEach((value, i) => {
                if (value === null) {
                  pen = false;
                  return;
                }
                path += `${pen ? 'L' : 'M'}${xAt(i)},${yAt(value)} `;
                pen = true;
              });
              return (
                <path
                  key={s.name}
                  d={path}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className={s.color.stroke}
                />
              );
            })}

          {kind === 'line' &&
            active !== null &&
            series.map(
              (s) =>
                s.values[active] !== null &&
                s.values[active] !== undefined && (
                  // The ring keeps the marker legible where lines cross.
                  <circle
                    key={s.name}
                    cx={xAt(active)}
                    cy={yAt(s.values[active] as number)}
                    r={5}
                    strokeWidth={2}
                    className={`${s.color.fill} ${SURFACE_STROKE}`}
                  />
                ),
            )}

          {labelEnds &&
            lineEnds.map((end) => (
              <text
                key={end.name}
                x={xAt(end.index) + 8}
                y={end.y + 4}
                className="fill-gray-700 text-[11px] dark:fill-gray-300"
              >
                {end.name.length > 16 ? `${end.name.slice(0, 15)}…` : end.name}
              </text>
            ))}
        </svg>

        {active !== null && count > 0 && (
          <div
            role="status"
            // Flips to the other side of the pointer past the midpoint, so it
            // never runs off the card.
            style={
              xAt(active) > width / 2
                ? { right: width - xAt(active) + 12 }
                : { left: xAt(active) + 12 }
            }
            className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-md dark:border-gray-700 dark:bg-surface-dark-elevated"
          >
            <div className="mb-1 text-gray-600 dark:text-gray-300">
              {categories[active]}
            </div>
            {series.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`h-0.5 w-3 shrink-0 ${s.color.swatch}`}
                />
                {/* The value leads: here the reader has the series and wants
                    the number. */}
                <span className="font-semibold tabular-nums text-black dark:text-white">
                  {s.values[active] === null || s.values[active] === undefined
                    ? '—'
                    : `${formatFull(s.values[active] as number, locale)}${unit ? ` ${unit}` : ''}`}
                </span>
                {series.length > 1 && (
                  <span className="text-gray-600 dark:text-gray-300">
                    {s.name}
                  </span>
                )}
              </div>
            ))}
            {stacked && totalLabel && (
              <div className="mt-1 flex items-center gap-2 border-t border-gray-200 pt-1 dark:border-gray-700">
                <span className="w-3 shrink-0" />
                <span className="font-semibold tabular-nums text-black dark:text-white">
                  {formatFull(totals[active], locale)}
                  {unit ? ` ${unit}` : ''}
                </span>
                <span className="text-gray-600 dark:text-gray-300">
                  {totalLabel}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
