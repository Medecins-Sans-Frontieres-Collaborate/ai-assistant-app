'use client';

import { DateSeriesSplitResult } from '@/lib/services/workflows/data/aggregate';

import {
  ChartFrame,
  PLOT,
  PLOT_H,
  PLOT_W,
  formatTick,
  niceMax,
} from './ChartFrame';
import { SERIES_COLORS } from './palette';

interface MultiLineChartSvgProps {
  data: DateSeriesSplitResult;
  ariaLabel: string;
}

/** Split-by line chart: one path per series; null values break the line. */
export function MultiLineChartSvg({ data, ariaLabel }: MultiLineChartSvgProps) {
  const { points, seriesKeys } = data;
  if (points.length === 0 || seriesKeys.length === 0) return null;
  const allValues = points.flatMap((p) =>
    p.values.filter((v): v is number => v !== null),
  );
  const yMax = niceMax(Math.max(...allValues, 0));
  const step = points.length > 1 ? PLOT_W / (points.length - 1) : 0;
  const toX = (index: number) =>
    points.length > 1 ? PLOT.left + index * step : PLOT.left + PLOT_W / 2;
  const toY = (value: number) => PLOT.top + PLOT_H - (value / yMax) * PLOT_H;
  const showDots = points.length <= 60;

  return (
    <ChartFrame ariaLabel={ariaLabel} yMax={yMax}>
      {seriesKeys.map((series, seriesIndex) => {
        let path = '';
        let pendingMove = true;
        points.forEach((point, pointIndex) => {
          const value = point.values[seriesIndex];
          if (value === null) {
            pendingMove = true;
            return;
          }
          path += `${pendingMove ? 'M' : 'L'}${toX(pointIndex)},${toY(value)} `;
          pendingMove = false;
        });
        return (
          <g key={series}>
            <path
              d={path.trim()}
              fill="none"
              strokeWidth={1.5}
              className={SERIES_COLORS[seriesIndex].stroke}
            />
            {showDots &&
              points.map((point, pointIndex) => {
                const value = point.values[seriesIndex];
                if (value === null) return null;
                return (
                  <circle
                    key={point.date}
                    cx={toX(pointIndex)}
                    cy={toY(value)}
                    r={2.5}
                    className={SERIES_COLORS[seriesIndex].fill}
                  >
                    <title>{`${point.date} · ${series}: ${formatTick(value)}`}</title>
                  </circle>
                );
              })}
          </g>
        );
      })}
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
