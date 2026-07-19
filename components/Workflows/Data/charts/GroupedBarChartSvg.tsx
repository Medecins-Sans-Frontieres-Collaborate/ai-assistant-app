'use client';

import { GroupBySplitResult } from '@/lib/services/workflows/data/aggregate';

import {
  ChartFrame,
  PLOT,
  PLOT_H,
  PLOT_W,
  formatTick,
  niceMax,
  truncateLabel,
} from './ChartFrame';
import { SERIES_COLORS } from './palette';

interface GroupedBarChartSvgProps {
  data: GroupBySplitResult;
  ariaLabel: string;
}

/** Split-by bar chart: one colored sub-bar per series within a group. */
export function GroupedBarChartSvg({
  data,
  ariaLabel,
}: GroupedBarChartSvgProps) {
  const { groups, seriesKeys } = data;
  if (groups.length === 0 || seriesKeys.length === 0) return null;
  const allValues = groups.flatMap((g) =>
    g.values.filter((v): v is number => v !== null),
  );
  const yMax = niceMax(Math.max(...allValues, 0));
  const slot = PLOT_W / groups.length;
  const barWidth = Math.min((slot * 0.8) / seriesKeys.length, 24);
  const clusterWidth = barWidth * seriesKeys.length;
  const labelEvery = Math.max(1, Math.ceil(groups.length / 16));

  return (
    <ChartFrame ariaLabel={ariaLabel} yMax={yMax}>
      {groups.map((group, groupIndex) => {
        const clusterStart =
          PLOT.left + groupIndex * slot + (slot - clusterWidth) / 2;
        return (
          <g key={group.key}>
            {group.values.map((value, seriesIndex) => {
              if (value === null) return null;
              const height = (Math.max(value, 0) / yMax) * PLOT_H;
              const x = clusterStart + seriesIndex * barWidth;
              return (
                <rect
                  key={seriesKeys[seriesIndex]}
                  x={x}
                  y={PLOT.top + PLOT_H - height}
                  width={Math.max(barWidth - 1, 1)}
                  height={height}
                  rx={1.5}
                  className={SERIES_COLORS[seriesIndex].fill}
                >
                  <title>{`${group.key} · ${seriesKeys[seriesIndex]}: ${formatTick(value)}`}</title>
                </rect>
              );
            })}
            {groupIndex % labelEvery === 0 && (
              <text
                x={clusterStart + clusterWidth / 2}
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
