'use client';

import { FC, ReactNode } from 'react';

interface StatTileProps {
  /** Sentence case, no trailing colon. */
  label: string;
  /** Already formatted (compact). */
  value: string;
  /** The unit, when the value alone would be ambiguous ("kg CO₂e"). */
  unit?: string;
  /** What to read it against: a comparator, a share, a change. */
  detail?: ReactNode;
}

/**
 * One headline figure. The number IS the chart: a single value never gets a
 * one-bar bar chart.
 *
 * Proportional figures on purpose — `tabular-nums` makes a standalone "121"
 * look loose at this size. Tabular figures belong in columns.
 */
export const StatTile: FC<StatTileProps> = ({ label, value, unit, detail }) => (
  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
    <dt className="text-xs font-medium text-gray-600 dark:text-gray-300">
      {label}
    </dt>
    <dd className="mt-1">
      <span className="text-2xl font-semibold text-black dark:text-white">
        {value}
      </span>
      {unit && (
        <span className="ml-1 text-sm text-gray-600 dark:text-gray-300">
          {unit}
        </span>
      )}
      {detail && (
        <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
          {detail}
        </span>
      )}
    </dd>
  </div>
);

/** A row of headline figures above the charts they summarise. */
export const StatRow: FC<{ children: ReactNode }> = ({ children }) => (
  <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
    {children}
  </dl>
);
