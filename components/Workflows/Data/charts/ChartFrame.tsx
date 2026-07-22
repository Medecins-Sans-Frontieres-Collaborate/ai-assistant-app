'use client';

import { ReactNode } from 'react';

/**
 * Shared skeleton for the hand-rolled SVG charts (no charting dep):
 * fixed viewBox, a y axis with three ticks (0 / half / max), and the
 * plot area geometry the charts draw into. Marks carry a <title> as the
 * native tooltip.
 */

export const CHART_W = 640;
export const CHART_H = 240;
export const PLOT = { left: 52, right: 8, top: 10, bottom: 30 } as const;
export const PLOT_W = CHART_W - PLOT.left - PLOT.right;
export const PLOT_H = CHART_H - PLOT.top - PLOT.bottom;

/** A pleasant axis maximum: 1/2/5 × 10^k at or above the data max. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = Math.floor(Math.log10(value));
  const base = Math.pow(10, power);
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

export function formatTick(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `${Number((value / 1000).toFixed(1))}k`;
  }
  return String(Number(value.toFixed(2)));
}

export function truncateLabel(label: string, max = 12): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

interface ChartFrameProps {
  ariaLabel: string;
  /** Y axis maximum (use niceMax of the data max). */
  yMax: number;
  /** Y axis minimum; defaults to the historical 0 baseline. */
  yMin?: number;
  /** When set, renders min/mid/max labels along the x axis (scatter). */
  xDomain?: { min: number; max: number };
  children: ReactNode;
}

export function ChartFrame({
  ariaLabel,
  yMax,
  yMin = 0,
  xDomain,
  children,
}: ChartFrameProps) {
  const ticks = [yMin, (yMin + yMax) / 2, yMax];
  const ySpan = yMax - yMin || 1;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label={ariaLabel}
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {xDomain &&
        [
          { value: xDomain.min, x: PLOT.left, anchor: 'start' as const },
          {
            value: (xDomain.min + xDomain.max) / 2,
            x: PLOT.left + PLOT_W / 2,
            anchor: 'middle' as const,
          },
          { value: xDomain.max, x: PLOT.left + PLOT_W, anchor: 'end' as const },
        ].map((tick) => (
          <text
            key={`x${tick.x}`}
            x={tick.x}
            y={PLOT.top + PLOT_H + 14}
            textAnchor={tick.anchor}
            className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
          >
            {formatTick(tick.value)}
          </text>
        ))}
      {ticks.map((tick) => {
        const y = PLOT.top + PLOT_H - ((tick - yMin) / ySpan) * PLOT_H;
        return (
          <g key={tick}>
            <line
              x1={PLOT.left}
              x2={PLOT.left + PLOT_W}
              y1={y}
              y2={y}
              className="stroke-gray-200 dark:stroke-gray-700"
              strokeWidth={1}
            />
            <text
              x={PLOT.left - 6}
              y={y + 3.5}
              textAnchor="end"
              className="fill-gray-500 text-[11px] tabular-nums dark:fill-gray-400"
            >
              {formatTick(tick)}
            </text>
          </g>
        );
      })}
      {children}
    </svg>
  );
}
