'use client';

import { ScatterPoint } from '@/lib/services/workflows/data/aggregate';

import { ChartFrame, PLOT, PLOT_H, PLOT_W, formatTick } from './ChartFrame';

interface ScatterSvgProps {
  points: ScatterPoint[];
  ariaLabel: string;
}

/** Pads a raw domain 5% each side; ±1 for a constant axis. */
function padDomain(values: number[]): { min: number; max: number } {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

/**
 * Two-numeric-column scatter. Domains follow the data (no forced zero
 * baseline — values may be negative or far from the origin), so niceMax
 * is deliberately not used.
 */
export function ScatterSvg({ points, ariaLabel }: ScatterSvgProps) {
  if (points.length === 0) return null;
  const xDomain = padDomain(points.map((p) => p.x));
  const yDomain = padDomain(points.map((p) => p.y));
  const toX = (x: number) =>
    PLOT.left + ((x - xDomain.min) / (xDomain.max - xDomain.min)) * PLOT_W;
  const toY = (y: number) =>
    PLOT.top +
    PLOT_H -
    ((y - yDomain.min) / (yDomain.max - yDomain.min)) * PLOT_H;

  return (
    <ChartFrame
      ariaLabel={ariaLabel}
      yMin={yDomain.min}
      yMax={yDomain.max}
      xDomain={xDomain}
    >
      {points.map((point, index) => (
        <circle
          key={index}
          cx={toX(point.x)}
          cy={toY(point.y)}
          r={2.5}
          className="fill-blue-500/70 dark:fill-blue-400/60"
        >
          <title>{`${formatTick(point.x)} / ${formatTick(point.y)}`}</title>
        </circle>
      ))}
    </ChartFrame>
  );
}
