'use client';

import { useTranslations } from 'next-intl';

import {
  CategoryChip,
  OTHER_CATEGORY_KEY,
} from '@/lib/utils/shared/geo/categories';

interface CategoryFilterBarProps {
  chips: CategoryChip[];
  active: Set<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}

/**
 * Toggle chips filtering the feature list AND the map by category.
 * Ephemeral view state — never persisted with the conversation.
 */
export function CategoryFilterBar({
  chips,
  active,
  onToggle,
  onClear,
}: CategoryFilterBarProps) {
  const t = useTranslations('workflows');

  if (chips.length < 2) return null;

  return (
    <div
      role="group"
      aria-label={t('map.filters.label')}
      className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-gray-50/95 px-3 py-2 dark:border-gray-700 dark:bg-surface-dark-recessed/95"
    >
      {chips.map((chip) => {
        const isActive = active.has(chip.key);
        const label =
          chip.key === OTHER_CATEGORY_KEY ? t('map.filters.other') : chip.label;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(chip.key)}
            className={`inline-flex min-h-[32px] items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
              isActive
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
            }`}
          >
            {label}
            <span
              className={
                isActive ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'
              }
            >
              {chip.count}
            </span>
          </button>
        );
      })}
      {active.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="min-h-[32px] rounded-full px-2 py-1 text-xs text-gray-600 underline-offset-2 hover:underline dark:text-gray-400"
        >
          {t('map.filters.clear')}
        </button>
      )}
    </div>
  );
}
