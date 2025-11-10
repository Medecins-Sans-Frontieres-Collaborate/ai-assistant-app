import { IconWorld } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { SearchMode } from '@/types/searchMode';

interface SearchModeBadgeProps {
  onRemove: () => void;
}

/**
 * Badge component that displays when search mode is enabled
 * Shows a visual indicator and allows removal
 */
export const SearchModeBadge: React.FC<SearchModeBadgeProps> = ({
  onRemove,
}) => {
  const t = useTranslations();

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm font-medium border border-gray-300 dark:border-gray-600">
      <IconWorld className="w-5 h-5 text-blue-500" />
      <span>Search</span>
      <button
        onClick={onRemove}
        className="ml-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-full p-0.5 transition-colors"
        aria-label={t('chat.disableWebSearch')}
      >
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
};
