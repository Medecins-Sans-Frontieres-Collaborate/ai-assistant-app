'use client';

import { IconArrowDown, IconArrowUp, IconEyeOff } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FC, useMemo, useRef, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { ColumnView } from '@/lib/services/analytics/previewModel';
import { Cell } from '@/lib/services/analytics/tables';

const ROW_HEIGHT = 33;
const TEXT_WIDTH = 200;
const VALUE_WIDTH = 140;

export interface GridSort {
  column: number;
  direction: 'asc' | 'desc';
}

function compareCells(a: Cell, b: Cell): number {
  // Blanks sort last in either direction (handled by the caller's sign).
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Rows containing `needle` in any cell, case-insensitively. */
export function filterRows(rows: readonly Cell[][], needle: string): Cell[][] {
  const text = needle.trim().toLowerCase();
  if (text === '') return rows as Cell[][];
  return rows.filter((row) =>
    row.some(
      (cell) => cell !== null && String(cell).toLowerCase().includes(text),
    ),
  );
}

export function sortRows(
  rows: readonly Cell[][],
  sort: GridSort | null,
): Cell[][] {
  if (!sort) return rows as Cell[][];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[sort.column] ?? null;
    const b = right[sort.column] ?? null;
    const aBlank = a === null || a === '';
    const bBlank = b === null || b === '';
    if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;
    return sign * compareCells(a, b);
  });
}

interface PreviewGridProps {
  columns: ColumnView[];
  /** Already filtered by the parent, so the chart sees the same rows. */
  rows: Cell[][];
  /** A laid-out page: no header row, no sorting. */
  freeform: boolean;
  ariaLabel: string;
}

/**
 * Read-only, virtualized grid for a delivered table.
 *
 * Hand-rolled sort over plain arrays rather than a table library: the rows
 * are positional (`Cell[][]`), there is no editing, selection or resizing,
 * and the only library piece worth having is the virtualizer.
 *
 * A column users do not get is shown to admins with a marker, not hidden —
 * they are the ones who decide whether it should be.
 */
export const PreviewGrid: FC<PreviewGridProps> = ({
  columns,
  rows,
  freeform,
  ariaLabel,
}) => {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const [sort, setSort] = useState<GridSort | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () => (freeform ? rows : sortRows(rows, sort)),
    [rows, sort, freeform],
  );
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    [locale],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const widthOf = (column: ColumnView) =>
    column.kind === 'text' ? TEXT_WIDTH : VALUE_WIDTH;
  const alignEnd = (column: ColumnView) =>
    !freeform && column.kind === 'number';

  const toggleSort = (index: number) =>
    setSort((current) =>
      current?.column !== index
        ? { column: index, direction: 'asc' }
        : current.direction === 'asc'
          ? { column: index, direction: 'desc' }
          : null,
    );

  const display = (cell: Cell) =>
    cell === null
      ? ''
      : typeof cell === 'number'
        ? numberFormat.format(cell)
        : String(cell);

  return (
    <div
      ref={scrollRef}
      className="h-[60vh] min-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
    >
      <table
        aria-label={ariaLabel}
        aria-rowcount={sorted.length + 1}
        className="w-max min-w-full border-collapse text-sm"
      >
        <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-surface-dark-recessed">
          {/* Flex rows, like the virtualized body, so header and cell widths
              always agree. */}
          <tr className="flex w-full min-w-max border-b border-gray-200 dark:border-gray-700">
            {columns.map((column, index) => {
              const direction = sort?.column === index ? sort.direction : null;
              return (
                <th
                  key={`${column.name}-${index}`}
                  scope="col"
                  aria-sort={
                    direction === 'asc'
                      ? 'ascending'
                      : direction === 'desc'
                        ? 'descending'
                        : undefined
                  }
                  style={{ width: widthOf(column) }}
                  className="shrink-0 px-3 py-1.5 text-start font-medium text-gray-700 dark:text-gray-300"
                >
                  <span
                    className={`flex items-center gap-1 ${alignEnd(column) ? 'justify-end' : ''}`}
                  >
                    {freeform ? (
                      <span className="truncate">{column.name}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(index)}
                        className="inline-flex min-w-0 items-center gap-1 rounded hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-white"
                      >
                        <span className="truncate">{column.name}</span>
                        {direction === 'asc' && (
                          <IconArrowUp size={14} aria-hidden="true" />
                        )}
                        {direction === 'desc' && (
                          <IconArrowDown size={14} aria-hidden="true" />
                        )}
                      </button>
                    )}
                    {column.hiddenFromUsers && (
                      <span
                        title={t('preview.hiddenColumn')}
                        className="shrink-0 text-amber-600 dark:text-amber-400"
                      >
                        <IconEyeOff size={14} aria-hidden="true" />
                        <span className="sr-only">
                          {t('preview.hiddenColumn')}
                        </span>
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = sorted[virtualRow.index];
            return (
              <tr
                key={virtualRow.index}
                aria-rowindex={virtualRow.index + 2}
                className="absolute left-0 top-0 flex w-full min-w-max border-b border-gray-100 bg-white dark:border-gray-800 dark:bg-surface-dark"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: `${ROW_HEIGHT}px`,
                }}
              >
                {columns.map((column, index) => (
                  <td
                    key={index}
                    style={{ width: widthOf(column) }}
                    title={
                      typeof row[index] === 'string'
                        ? (row[index] as string)
                        : undefined
                    }
                    className={`shrink-0 truncate px-3 py-1.5 text-black dark:text-white ${
                      alignEnd(column) ? 'text-end tabular-nums' : ''
                    }`}
                  >
                    {display(row[index] ?? null)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
