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
  children: ReactNode;
}

export function ChartFrame({ ariaLabel, yMax, children }: ChartFrameProps) {
  const ticks = [0, yMax / 2, yMax];
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label={ariaLabel}
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {ticks.map((tick) => {
        const y = PLOT.top + PLOT_H - (tick / yMax) * PLOT_H;
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
