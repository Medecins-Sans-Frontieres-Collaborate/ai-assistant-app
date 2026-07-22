'use client';

import { useTranslations } from 'next-intl';

import { AggFn, PivotResult } from '@/lib/services/workflows/data/aggregate';
import { formatNumberForDisplay } from '@/lib/services/workflows/data/numberFormat';

import { DataColumn } from '@/types/workflow';

interface PivotTableProps {
  data: PivotResult;
  groupColumn: DataColumn;
  /** Aligned with data.rows[i].values. */
  valueColumns: DataColumn[];
  agg: AggFn;
  ariaLabel: string;
}

/**
 * Group-by summary table: rows = categories, columns = the chosen
 * aggregate over several numeric columns at once. HTML (not SVG) —
 * scrolls, wraps, and inherits dark mode.
 */
export function PivotTable({
  data,
  groupColumn,
  valueColumns,
  agg,
  ariaLabel,
}: PivotTableProps) {
  const t = useTranslations('workflows.data');
  if (data.rows.length === 0) return null;

  const formatValue = (value: number | null, column: DataColumn): string => {
    if (value === null) return '–';
    const rounded = Number(value.toFixed(2));
    return column.format
      ? formatNumberForDisplay(rounded, column.format)
      : String(rounded);
  };
  const aggLabel = t(`agg${agg.charAt(0).toUpperCase()}${agg.slice(1)}`);

  return (
    <div className="h-full overflow-auto" aria-label={ariaLabel} role="region">
      <table className="w-full text-start text-xs">
        <thead className="sticky top-0 bg-white dark:bg-surface-dark">
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className="px-2 py-1.5 text-start font-medium text-gray-700 dark:text-gray-300">
              {groupColumn.name}
            </th>
            <th className="px-2 py-1.5 text-end font-medium text-gray-700 dark:text-gray-300">
              {t('aggCount')}
            </th>
            {valueColumns.map((column) => (
              <th
                key={column.id}
                className="px-2 py-1.5 text-end font-medium text-gray-700 dark:text-gray-300"
              >
                {column.name}
                <span className="ms-1 font-normal text-gray-400">
                  {aggLabel}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr
              key={row.key}
              className="border-b border-gray-100 dark:border-gray-800"
            >
              <td className="max-w-48 truncate px-2 py-1 text-gray-800 dark:text-gray-200">
                {row.key}
              </td>
              <td className="px-2 py-1 text-end tabular-nums text-gray-800 dark:text-gray-200">
                {row.count}
              </td>
              {row.values.map((value, index) => (
                <td
                  key={valueColumns[index]?.id ?? index}
                  className="px-2 py-1 text-end tabular-nums text-gray-800 dark:text-gray-200"
                >
                  {formatValue(value, valueColumns[index])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
