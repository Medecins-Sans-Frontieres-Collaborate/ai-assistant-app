'use client';

import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { formatCell, getRowId } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

interface RecordViewProps {
  columns: DataColumn[];
  /** The rows in view; one record is shown at a time. */
  rows: Record<string, unknown>[];
  /** rid → columnId → flag (same map the grid renders). */
  cellFlags?: Map<string, Map<string, 'missing' | 'pending'>>;
  /** Writes one cell (raw string input; the workspace coerces). */
  onSetCell: (rid: string, columnId: string, raw: string) => void;
  disabled?: boolean;
}

const fieldClasses =
  'min-h-[36px] w-full rounded-lg border bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:bg-surface-dark dark:text-gray-100';

/**
 * Form-style view of one record — the natural shape for a photographed
 * single form (non-repeated fields). The same columns×rows model as the
 * grid: one row rendered vertically, every field editable, required
 * fields marked and flagged when empty. Multiple records get a
 * navigator.
 */
export function RecordView({
  columns,
  rows,
  cellFlags,
  onSetCell,
  disabled,
}: RecordViewProps) {
  const t = useTranslations('workflows.data');
  const [index, setIndex] = useState(0);

  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-gray-500 dark:text-gray-400">
        {t('recordEmpty')}
      </p>
    );
  }

  const safeIndex = Math.min(index, rows.length - 1);
  const row = rows[safeIndex];
  const rid = getRowId(row) ?? '';

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-xl p-4">
        {rows.length > 1 && (
          <div className="mb-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={safeIndex === 0}
              aria-label={t('recordPrev')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconChevronLeft size={15} aria-hidden />
            </button>
            <span className="text-sm tabular-nums text-gray-600 dark:text-gray-400">
              {t('recordOf', {
                index: String(safeIndex + 1),
                count: String(rows.length),
              })}
            </span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(rows.length - 1, i + 1))}
              disabled={safeIndex === rows.length - 1}
              aria-label={t('recordNext')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconChevronRight size={15} aria-hidden />
            </button>
          </div>
        )}

        <div className="space-y-3">
          {columns.map((column) => {
            const value = formatCell(row[column.id]);
            const flag = cellFlags?.get(rid)?.get(column.id);
            const flagClasses =
              flag === 'missing'
                ? 'border-red-400 dark:border-red-700'
                : flag === 'pending'
                  ? 'border-amber-400 dark:border-amber-700'
                  : 'border-gray-300 dark:border-gray-700';
            const inputId = `record-field-${column.id}`;
            return (
              <div key={column.id}>
                <label
                  htmlFor={inputId}
                  className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
                >
                  {column.name}
                  {column.required && (
                    <span
                      className="ms-0.5 text-red-500 dark:text-red-400"
                      title={t('requiredColumn')}
                    >
                      *
                    </span>
                  )}
                  <span className="ms-1.5 text-[10px] font-normal uppercase text-gray-400">
                    {column.type}
                  </span>
                </label>
                {column.type === 'boolean' ? (
                  <select
                    id={inputId}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onSetCell(rid, column.id, e.target.value)}
                    className={`${fieldClasses} ${flagClasses}`}
                  >
                    <option value="">{t('recordBooleanUnset')}</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={inputId}
                    type={
                      column.type === 'number'
                        ? 'number'
                        : column.type === 'date'
                          ? 'date'
                          : 'text'
                    }
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onSetCell(rid, column.id, e.target.value)}
                    className={`${fieldClasses} ${flagClasses}`}
                  />
                )}
                {flag === 'missing' && (
                  <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">
                    {t('flagMissingRequired')}
                  </p>
                )}
                {flag === 'pending' && (
                  <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {t('flagPendingEdit')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
