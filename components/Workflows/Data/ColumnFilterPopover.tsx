'use client';

import { useTranslations } from 'next-intl';

import { TOP_VALUES_MAX_DISTINCT } from '@/lib/services/workflows/data/columnStats';
import {
  ColumnFilter,
  defaultFilterKind,
} from '@/lib/services/workflows/data/filtering';

import { ColumnProfile, DataColumn } from '@/types/workflow';

interface ColumnFilterPopoverProps {
  column: DataColumn;
  profile: ColumnProfile;
  filter: ColumnFilter | undefined;
  onChange: (filter: ColumnFilter | null) => void;
  onClose: () => void;
}

const inputClasses =
  'w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100 dark:placeholder-gray-400';

/**
 * Per-column filter editor, type-driven: number → min/max, date →
 * ISO range, low-cardinality text/boolean → value checkboxes, otherwise
 * case-insensitive contains. Filters are an ephemeral view concern.
 */
export function ColumnFilterPopover({
  column,
  profile,
  filter,
  onChange,
  onClose,
}: ColumnFilterPopoverProps) {
  const t = useTranslations('workflows.data');
  const kind = defaultFilterKind(
    column,
    profile.distinct,
    TOP_VALUES_MAX_DISTINCT,
  );

  const valueOptions = profile.topValues ?? [];

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={t('filterColumnFor', { column: column.name })}
        className="absolute start-0 top-full z-30 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-3 text-start shadow-lg dark:border-gray-700 dark:bg-surface-dark-elevated"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
            {t('filterColumnFor', { column: column.name })}
          </p>
          {filter && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
            >
              {t('filterClear')}
            </button>
          )}
        </div>

        {kind === 'text' && (
          <input
            type="text"
            value={filter?.kind === 'text' ? filter.query : ''}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? { columnId: column.id, kind: 'text', query: e.target.value }
                  : null,
              )
            }
            placeholder={t('filterContains')}
            className={`mt-2 ${inputClasses}`}
            autoFocus
          />
        )}

        {kind === 'range' && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              value={filter?.kind === 'range' ? (filter.min ?? '') : ''}
              onChange={(e) => {
                const min =
                  e.target.value === '' ? undefined : Number(e.target.value);
                const max = filter?.kind === 'range' ? filter.max : undefined;
                onChange(
                  min === undefined && max === undefined
                    ? null
                    : { columnId: column.id, kind: 'range', min, max },
                );
              }}
              placeholder={t('filterMin')}
              aria-label={t('filterMin')}
              className={inputClasses}
            />
            <span className="text-xs text-gray-400">–</span>
            <input
              type="number"
              value={filter?.kind === 'range' ? (filter.max ?? '') : ''}
              onChange={(e) => {
                const max =
                  e.target.value === '' ? undefined : Number(e.target.value);
                const min = filter?.kind === 'range' ? filter.min : undefined;
                onChange(
                  min === undefined && max === undefined
                    ? null
                    : { columnId: column.id, kind: 'range', min, max },
                );
              }}
              placeholder={t('filterMax')}
              aria-label={t('filterMax')}
              className={inputClasses}
            />
          </div>
        )}

        {kind === 'dateRange' && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="date"
              value={filter?.kind === 'dateRange' ? (filter.min ?? '') : ''}
              onChange={(e) => {
                const min = e.target.value || undefined;
                const max =
                  filter?.kind === 'dateRange' ? filter.max : undefined;
                onChange(
                  !min && !max
                    ? null
                    : { columnId: column.id, kind: 'dateRange', min, max },
                );
              }}
              aria-label={t('filterMin')}
              className={inputClasses}
            />
            <span className="text-xs text-gray-400">–</span>
            <input
              type="date"
              value={filter?.kind === 'dateRange' ? (filter.max ?? '') : ''}
              onChange={(e) => {
                const max = e.target.value || undefined;
                const min =
                  filter?.kind === 'dateRange' ? filter.min : undefined;
                onChange(
                  !min && !max
                    ? null
                    : { columnId: column.id, kind: 'dateRange', min, max },
                );
              }}
              aria-label={t('filterMax')}
              className={inputClasses}
            />
          </div>
        )}

        {kind === 'values' && (
          <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">
            {valueOptions.map((option) => {
              const selected =
                filter?.kind === 'values' &&
                filter.values.includes(option.value);
              return (
                <li key={option.value}>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        const current =
                          filter?.kind === 'values' ? filter.values : [];
                        const values = selected
                          ? current.filter((v) => v !== option.value)
                          : [...current, option.value];
                        onChange(
                          values.length === 0
                            ? null
                            : { columnId: column.id, kind: 'values', values },
                        );
                      }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={option.value}
                    >
                      {option.value}
                    </span>
                    <span className="tabular-nums text-gray-400">
                      {option.count.toLocaleString()}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
