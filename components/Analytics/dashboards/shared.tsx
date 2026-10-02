'use client';

import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import { ReportPeriod } from '@/lib/services/analytics/retention';
import { SMALL_GROUPS_LABEL } from '@/lib/services/analytics/rollup';
import { RollupView } from '@/lib/services/analytics/rollupModel';
import { Cell } from '@/lib/services/analytics/tables';

import { BarItem } from '@/components/Charts/BarList';

/** A dataset read by column name. */
export interface DatasetReader {
  rows: Cell[][];
  folded: boolean;
  num: (row: Cell[], column: string) => number;
  maybeNum: (row: Cell[], column: string) => number | null;
  text: (row: Cell[], column: string) => string;
}

export function readDataset(
  view: Pick<RollupView, 'datasets'>,
  name: string,
): DatasetReader | null {
  const dataset = view.datasets[name];
  if (!dataset) return null;
  const at = (column: string) => dataset.columns.indexOf(column);
  const cell = (row: Cell[], column: string) => row[at(column)] ?? null;
  return {
    rows: dataset.rows,
    folded: dataset.folded,
    num: (row, column) => {
      const value = cell(row, column);
      return typeof value === 'number' ? value : 0;
    },
    maybeNum: (row, column) => {
      const value = cell(row, column);
      return typeof value === 'number' ? value : null;
    },
    text: (row, column) => String(cell(row, column) ?? ''),
  };
}

/** Bars for a `group` breakdown; the folded row is muted and named. */
export function barsOf(
  reader: DatasetReader,
  measure: string,
  smallGroupsLabel: string,
  labelColumn = 'group',
): BarItem[] {
  return reader.rows.map((row) => {
    const label = reader.text(row, labelColumn);
    const small = label === SMALL_GROUPS_LABEL;
    return {
      label: small ? smallGroupsLabel : label,
      value: reader.num(row, measure),
      muted: small,
    };
  });
}

/** "1 Jul" for a day axis; the value is a date or a timestamp. */
export function shortDay(value: string, locale: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/** "Jul 26" for a month, "1 Jul 26" for anything shorter — a trend's x axis. */
export function shortPeriod(period: ReportPeriod, locale: string): string {
  const end = new Date(`${period.to}T00:00:00.000Z`);
  const wholeMonth =
    period.from.slice(0, 7) === period.to.slice(0, 7) &&
    period.from.endsWith('-01') &&
    period.from !== period.to;
  return new Intl.DateTimeFormat(locale, {
    ...(wholeMonth ? {} : { day: 'numeric' }),
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(end);
}

/** 1,322 g → "1.32 kg"; small amounts stay in the base unit. */
export function scaled(
  value: number,
  base: string,
  thousand: string,
): { value: number; unit: string } {
  return Math.abs(value) >= 1000
    ? { value: value / 1000, unit: thousand }
    : { value, unit: base };
}

interface PanelGateProps {
  view: Pick<RollupView, 'datasets' | 'withheld'>;
  /** Every dataset the panel draws from. */
  needs: string[];
  title: string;
  children: ReactNode;
}

/**
 * Renders a panel only when its data is there, and says WHY when it is not:
 * hidden by the field settings, or simply absent from this file. A dashboard
 * with silent gaps reads as broken; one that names them reads as deliberate.
 */
export const PanelGate: FC<PanelGateProps> = ({
  view,
  needs,
  title,
  children,
}) => {
  const t = useTranslations('analytics.dash');
  if (needs.every((name) => view.datasets[name])) return <>{children}</>;
  const hidden = needs.some((name) => view.withheld.includes(name));
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-4 dark:border-gray-600">
      <p className="text-sm font-semibold text-black dark:text-white">
        {title}
      </p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {hidden ? t('hiddenPanel') : t('missingPanel')}
      </p>
    </div>
  );
};

/** Two charts side by side on a wide screen, stacked on a narrow one. */
export const PanelGrid: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="grid gap-4 lg:grid-cols-2">{children}</div>
);
