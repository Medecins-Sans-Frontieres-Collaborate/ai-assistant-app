'use client';

import {
  IconArrowDown,
  IconArrowUp,
  IconChartBar,
  IconFilter,
} from '@tabler/icons-react';
import {
  ColumnDef,
  SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ColumnFilter } from '@/lib/services/workflows/data/filtering';
import { formatCell, getRowId } from '@/lib/services/workflows/data/tableUtils';

import { ColumnProfile, DataColumn } from '@/types/workflow';

import { ColumnFilterPopover } from './ColumnFilterPopover';
import { ColumnProfilePopover } from './ColumnProfilePopover';

type Row = Record<string, unknown>;

interface DataGridProps {
  columns: DataColumn[];
  /** The rows to display — already filtered by the workspace. */
  rows: Row[];
  /** Unfiltered table size, for the "Showing N of M" footer. */
  totalRowCount?: number;
  /** Deterministic per-column stats (full table), keyed by column id. */
  profiles?: Map<string, ColumnProfile>;
  /** rid → columnId → flag: 'missing' (required, red) / 'pending' (amber). */
  cellFlags?: Map<string, Map<string, 'missing' | 'pending'>>;
  filters?: Record<string, ColumnFilter>;
  onFilterChange?: (columnId: string, filter: ColumnFilter | null) => void;
  /** Stable row ids (__rid) of the selected rows. */
  selectedRows: Set<string>;
  onToggleRow: (rid: string) => void;
  onToggleAll: () => void;
}

const ROW_HEIGHT = 33;

/**
 * Virtualized data grid (headless TanStack Table + the repo's existing
 * TanStack virtualizer). Sorting is a client-side view concern; the
 * underlying workflowState row order is untouched.
 */
export function DataGrid({
  columns,
  rows,
  totalRowCount,
  profiles,
  cellFlags,
  filters,
  onFilterChange,
  selectedRows,
  onToggleRow,
  onToggleAll,
}: DataGridProps) {
  const t = useTranslations('workflows');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [openProfileId, setOpenProfileId] = useState<string | null>(null);
  const [openFilterId, setOpenFilterId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnById = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );

  const tableColumns = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        accessorFn: (row) => row[column.id],
        header: column.name,
        meta: { type: column.type },
      })),
    [columns],
  );

  // Advisory only: React Compiler (not enabled in this build) would skip
  // memoizing this component because TanStack Table instances return
  // unstable functions. Safe regardless — table-derived values render
  // inline only (never passed to memoized children), and the expensive
  // derivations are hand-memoized above.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    // Index fallback only for the transient pre-backfill render.
    getRowId: (row, index) => getRowId(row) ?? `i${index}`,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const stats = useMemo(() => {
    const numeric = columns.filter((c) => c.type === 'number');
    return numeric.map((column) => {
      const values = rows
        .map((row) => row[column.id])
        .filter((v): v is number => typeof v === 'number');
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        id: column.id,
        name: column.name,
        count: values.length,
        sum,
        mean: values.length ? sum / values.length : 0,
      };
    });
  }, [columns, rows]);

  // "All" = every VISIBLE row selected (selection may extend beyond a filter).
  const allSelected =
    rows.length > 0 &&
    rows.every((row) => {
      const rid = getRowId(row);
      return !!rid && selectedRows.has(rid);
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-surface-dark-recessed">
            <tr>
              <th className="w-9 border-b border-gray-200 px-2 py-1.5 dark:border-gray-700">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label={t('data.selectAllRows')}
                />
              </th>
              {table.getFlatHeaders().map((header) => {
                const sorted = header.column.getIsSorted();
                const type = (
                  header.column.columnDef.meta as { type?: string } | undefined
                )?.type;
                const profile = profiles?.get(header.column.id);
                const column = columnById.get(header.column.id);
                return (
                  <th
                    key={header.id}
                    style={{ width: 180, minWidth: 180, maxWidth: 180 }}
                    className="relative border-b border-gray-200 px-3 py-1.5 text-start font-medium text-gray-700 dark:border-gray-700 dark:text-gray-300"
                  >
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex min-w-0 items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100"
                      >
                        <span className="truncate">
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                        </span>
                        {column?.required && (
                          <span
                            className="text-red-500 dark:text-red-400"
                            title={t('data.requiredColumn')}
                          >
                            *
                          </span>
                        )}
                        <span className="text-[10px] font-normal uppercase text-gray-400">
                          {type}
                        </span>
                        {sorted === 'asc' && (
                          <IconArrowUp size={12} aria-hidden />
                        )}
                        {sorted === 'desc' && (
                          <IconArrowDown size={12} aria-hidden />
                        )}
                      </button>
                      {profile && column && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenFilterId(null);
                            setOpenProfileId((open) =>
                              open === column.id ? null : column.id,
                            );
                          }}
                          aria-expanded={openProfileId === column.id}
                          aria-label={t('data.columnProfileFor', {
                            column: column.name,
                          })}
                          className="ms-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-300"
                        >
                          <IconChartBar size={13} aria-hidden />
                        </button>
                      )}
                      {profile && column && onFilterChange && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenProfileId(null);
                            setOpenFilterId((open) =>
                              open === column.id ? null : column.id,
                            );
                          }}
                          aria-expanded={openFilterId === column.id}
                          aria-label={t('data.filterColumnFor', {
                            column: column.name,
                          })}
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-surface-dark-elevated ${
                            filters?.[column.id]
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                          }`}
                        >
                          <IconFilter size={13} aria-hidden />
                        </button>
                      )}
                    </div>
                    {profile && column && openProfileId === column.id && (
                      <ColumnProfilePopover
                        column={column}
                        profile={profile}
                        onClose={() => setOpenProfileId(null)}
                      />
                    )}
                    {profile &&
                      column &&
                      onFilterChange &&
                      openFilterId === column.id && (
                        <ColumnFilterPopover
                          column={column}
                          profile={profile}
                          filter={filters?.[column.id]}
                          onChange={(filter) =>
                            onFilterChange(column.id, filter)
                          }
                          onClose={() => setOpenFilterId(null)}
                        />
                      )}
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
              const row = tableRows[virtualRow.index];
              return (
                <tr
                  key={row.id}
                  className={`absolute left-0 top-0 flex w-full min-w-max border-b border-gray-100 dark:border-gray-800 ${
                    selectedRows.has(row.id)
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : 'bg-white dark:bg-surface-dark'
                  }`}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${ROW_HEIGHT}px`,
                  }}
                >
                  <td className="flex w-9 items-center justify-center px-2">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(row.id)}
                      onChange={() => onToggleRow(row.id)}
                      aria-label={t('data.selectRow', {
                        row: String(row.index + 1),
                      })}
                    />
                  </td>
                  {row.getVisibleCells().map((cell) => {
                    const flag = cellFlags?.get(row.id)?.get(cell.column.id);
                    return (
                      <td
                        key={cell.id}
                        className={`flex items-center overflow-hidden text-ellipsis whitespace-nowrap px-3 text-gray-800 dark:text-gray-200 ${
                          flag === 'missing'
                            ? 'bg-red-50 shadow-[inset_0_0_0_1px] shadow-red-300 dark:bg-red-900/20 dark:shadow-red-800'
                            : flag === 'pending'
                              ? 'bg-amber-50 shadow-[inset_0_0_0_1px] shadow-amber-300 dark:bg-amber-900/20 dark:shadow-amber-800'
                              : ''
                        }`}
                        style={{ width: 180 }}
                        title={
                          flag === 'missing'
                            ? t('data.flagMissingRequired')
                            : flag === 'pending'
                              ? t('data.flagPendingEdit')
                              : formatCell(cell.getValue())
                        }
                      >
                        {formatCell(cell.getValue())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>
          {totalRowCount !== undefined && totalRowCount !== rows.length
            ? t('data.showingRows', {
                shown: String(rows.length),
                total: String(totalRowCount),
              })
            : t('data.rowCount', { count: String(rows.length) })}
        </span>
        {stats.map((stat) => (
          <span key={stat.id}>
            {stat.name}: Σ {Number(stat.sum.toFixed(2))} · x̄{' '}
            {Number(stat.mean.toFixed(2))}
          </span>
        ))}
      </div>
    </div>
  );
}
