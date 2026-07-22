'use client';

import { DateSeriesPoint } from '@/lib/services/workflows/data/aggregate';

import {
  ChartFrame,
  PLOT,
  PLOT_H,
  PLOT_W,
  formatTick,
  niceMax,
} from './ChartFrame';

interface LineChartSvgProps {
  points: DateSeriesPoint[];
  ariaLabel: string;
}

/** Date-ordered numeric series (≤500 points, pre-downsampled). */
export function LineChartSvg({ points, ariaLabel }: LineChartSvgProps) {
  if (points.length === 0) return null;
  const yMax = niceMax(Math.max(...points.map((p) => p.value), 0));
  const step = points.length > 1 ? PLOT_W / (points.length - 1) : 0;

  const toX = (index: number) =>
    points.length > 1 ? PLOT.left + index * step : PLOT.left + PLOT_W / 2;
  const toY = (value: number) => PLOT.top + PLOT_H - (value / yMax) * PLOT_H;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i)},${toY(p.value)}`)
    .join(' ');

  // Only dot sparse series; dense ones read as the line alone.
  const showDots = points.length <= 60;

  return (
    <ChartFrame ariaLabel={ariaLabel} yMax={yMax}>
      <path
        d={path}
        fill="none"
        strokeWidth={1.5}
        className="stroke-blue-500 dark:stroke-blue-400"
      />
      {showDots &&
        points.map((point, index) => (
          <circle
            key={point.date}
            cx={toX(index)}
            cy={toY(point.value)}
            r={2.5}
            className="fill-blue-500 dark:fill-blue-400"
          >
            <title>{`${point.date}: ${formatTick(point.value)}`}</title>
          </circle>
        ))}
      <text
        x={PLOT.left}
        y={PLOT.top + PLOT_H + 14}
        textAnchor="start"
        className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
      >
        {points[0].date}
      </text>
      <text
        x={PLOT.left + PLOT_W}
        y={PLOT.top + PLOT_H + 14}
        textAnchor="end"
        className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
      >
        {points[points.length - 1].date}
      </text>
    </ChartFrame>
  );
}
