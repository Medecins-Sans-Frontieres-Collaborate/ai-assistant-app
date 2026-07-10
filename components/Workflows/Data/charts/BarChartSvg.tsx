'use client';

import { GroupByResult } from '@/lib/services/workflows/data/aggregate';

import {
  ChartFrame,
  PLOT,
  PLOT_H,
  PLOT_W,
  formatTick,
  niceMax,
  truncateLabel,
} from './ChartFrame';

interface BarChartSvgProps {
  data: GroupByResult;
  ariaLabel: string;
}

/** Vertical bars for a group-by aggregation (≤30 groups). */
export function BarChartSvg({ data, ariaLabel }: BarChartSvgProps) {
  const groups = data.groups;
  if (groups.length === 0) return null;
  const yMax = niceMax(Math.max(...groups.map((g) => g.value), 0));
  const slot = PLOT_W / groups.length;
  const barWidth = Math.min(slot * 0.7, 48);
  // Label every bar when they fit, else a subset.
  const labelEvery = Math.max(1, Math.ceil(groups.length / 16));

  return (
    <ChartFrame ariaLabel={ariaLabel} yMax={yMax}>
      {groups.map((group, index) => {
        const height = (group.value / yMax) * PLOT_H;
        const x = PLOT.left + index * slot + (slot - barWidth) / 2;
        const y = PLOT.top + PLOT_H - height;
        return (
          <g key={group.key}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={height}
              rx={2}
              className="fill-blue-500/80 dark:fill-blue-400/70"
            >
              <title>{`${group.key}: ${formatTick(group.value)}`}</title>
            </rect>
            {index % labelEvery === 0 && (
              <text
                x={x + barWidth / 2}
                y={PLOT.top + PLOT_H + 14}
                textAnchor="middle"
                className="fill-gray-500 text-[10px] dark:fill-gray-400"
              >
                {truncateLabel(group.key, 10)}
              </text>
            )}
          </g>
        );
      })}
    </ChartFrame>
  );
}
