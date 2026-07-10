'use client';

import { HistogramBin } from '@/lib/services/workflows/data/aggregate';

import {
  ChartFrame,
  PLOT,
  PLOT_H,
  PLOT_W,
  formatTick,
  niceMax,
} from './ChartFrame';

interface HistogramSvgProps {
  bins: HistogramBin[];
  ariaLabel: string;
}

/** Distribution of a numeric column (equal-width bins, touching bars). */
export function HistogramSvg({ bins, ariaLabel }: HistogramSvgProps) {
  if (bins.length === 0) return null;
  const yMax = niceMax(Math.max(...bins.map((b) => b.count), 0));
  const slot = PLOT_W / bins.length;

  return (
    <ChartFrame ariaLabel={ariaLabel} yMax={yMax}>
      {bins.map((bin, index) => {
        const height = (bin.count / yMax) * PLOT_H;
        return (
          <rect
            key={index}
            x={PLOT.left + index * slot + 0.5}
            y={PLOT.top + PLOT_H - height}
            width={Math.max(slot - 1, 1)}
            height={height}
            className="fill-blue-500/80 dark:fill-blue-400/70"
          >
            <title>{`${formatTick(bin.x0)} – ${formatTick(bin.x1)}: ${bin.count}`}</title>
          </rect>
        );
      })}
      {/* X extent labels */}
      <text
        x={PLOT.left}
        y={PLOT.top + PLOT_H + 14}
        textAnchor="start"
        className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
      >
        {formatTick(bins[0].x0)}
      </text>
      <text
        x={PLOT.left + PLOT_W}
        y={PLOT.top + PLOT_H + 14}
        textAnchor="end"
        className="fill-gray-500 text-[10px] tabular-nums dark:fill-gray-400"
      >
        {formatTick(bins[bins.length - 1].x1)}
      </text>
    </ChartFrame>
  );
}
