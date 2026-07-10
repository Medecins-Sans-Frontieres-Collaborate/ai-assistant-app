'use client';

import { useTranslations } from 'next-intl';

export type DataScope = 'table' | 'filtered' | 'selection';

interface ScopeChipProps {
  scope: DataScope;
  totalCount: number;
  filteredCount: number;
  selectedCount: number;
  onChange: (scope: DataScope) => void;
  disabled?: boolean;
}

/**
 * Explicit working-scope control for LLM operations (the document
 * workflow's rule, translated to tables): a segmented chip showing which
 * rows a transform/assessment will operate on. Segments only appear when
 * meaningful (filters active / rows selected); the narrowest available
 * scope is auto-selected, and the user can always widen back to the
 * full table.
 */
export function ScopeChip({
  scope,
  totalCount,
  filteredCount,
  selectedCount,
  onChange,
  disabled,
}: ScopeChipProps) {
  const t = useTranslations('workflows.data');

  const segments: Array<{ id: DataScope; label: string }> = [
    { id: 'table', label: t('scopeTable', { count: String(totalCount) }) },
  ];
  if (filteredCount < totalCount) {
    segments.push({
      id: 'filtered',
      label: t('scopeFiltered', { count: String(filteredCount) }),
    });
  }
  if (selectedCount > 0) {
    segments.push({
      id: 'selection',
      label: t('scopeSelection', { count: String(selectedCount) }),
    });
  }

  if (segments.length === 1) {
    return (
      <span className="inline-flex items-center rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {segments[0].label}
      </span>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('scopeLabel')}
      className="inline-flex items-center overflow-hidden rounded-lg border border-gray-200 text-xs dark:border-gray-700"
    >
      {segments.map((segment) => {
        const active = segment.id === scope;
        return (
          <button
            key={segment.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(segment.id)}
            className={`min-h-[28px] px-2 py-1 disabled:opacity-50 ${
              active
                ? 'bg-blue-100 font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated'
            }`}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
