'use client';

import { IconChartBar, IconTable } from '@tabler/icons-react';
import { FC, ReactNode, useId, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { ChartTable, formatFull } from '@/components/Charts/format';

interface ChartCardProps {
  title: string;
  /** What the figures are, or a caveat the reader needs before reading. */
  subtitle?: string;
  /** Shown under the chart: what was folded, what it is based on. */
  note?: string;
  /**
   * The same data as a table. Every chart has one: it is how the figures are
   * read without hovering, without colour, and by a screen reader.
   */
  table: ChartTable;
  children: ReactNode;
}

/**
 * The frame every dashboard chart sits in: a title, the chart, and a switch
 * to the same figures as a table.
 */
export const ChartCard: FC<ChartCardProps> = ({
  title,
  subtitle,
  note,
  table,
  children,
}) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const id = useId();
  const [asTable, setAsTable] = useState(false);

  return (
    <figure
      aria-labelledby={`${id}-title`}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark"
    >
      <div className="mb-3 flex items-start gap-3">
        <figcaption className="min-w-0 flex-1">
          <span
            id={`${id}-title`}
            className="block text-sm font-semibold text-black dark:text-white"
          >
            {title}
          </span>
          {subtitle && (
            <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-300">
              {subtitle}
            </span>
          )}
        </figcaption>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((current) => !current)}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
        >
          {asTable ? (
            <IconChartBar size={14} aria-hidden="true" />
          ) : (
            <IconTable size={14} aria-hidden="true" />
          )}
          {asTable ? t('showChart') : t('showTable')}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-xs text-gray-500 dark:bg-surface-dark dark:text-gray-400">
              <tr>
                {table.columns.map((column, index) => (
                  <th
                    key={`${column}-${index}`}
                    scope="col"
                    className={`border-b border-gray-200 px-2 py-1.5 font-medium dark:border-gray-700 ${
                      index === 0 ? '' : 'text-right'
                    }`}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-black dark:text-white">
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={`border-b border-gray-100 px-2 py-1.5 dark:border-gray-800 ${
                        index === 0 ? '' : 'text-right tabular-nums'
                      }`}
                    >
                      {cell === null
                        ? '—'
                        : typeof cell === 'number'
                          ? formatFull(cell, locale)
                          : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}

      {note && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{note}</p>
      )}
    </figure>
  );
};
