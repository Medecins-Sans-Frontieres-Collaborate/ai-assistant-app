'use client';

import { truncateLabel } from './ChartFrame';
import { SERIES_COLORS } from './palette';

interface ChartLegendProps {
  seriesKeys: string[];
}

/** HTML legend chips for split-by series (wraps; dark mode for free). */
export function ChartLegend({ seriesKeys }: ChartLegendProps) {
  if (seriesKeys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      {seriesKeys.map((series, index) => (
        <span
          key={series}
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"
          title={series}
        >
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-sm ${SERIES_COLORS[index].swatch}`}
          />
          {truncateLabel(series, 18)}
        </span>
      ))}
    </div>
  );
}
