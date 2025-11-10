import { IconSearch, IconX } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

interface DropdownSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
}

/**
 * Search/filter input for dropdown menus
 */
export const DropdownSearchInput: React.FC<DropdownSearchInputProps> = ({
  value,
  onChange,
  onClear,
  inputRef,
  placeholder = 'Search features...',
}) => {
  const t = useTranslations();

  return (
    <div className="sticky top-0 p-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 pl-10 pr-8 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-900 text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={t('chat.searchFeatures')}
          role="searchbox"
        />
        <IconSearch
          className="absolute left-3 top-2.5 text-gray-400 dark:text-gray-500"
          size={16}
        />
        {value && (
          <button
            onClick={onClear}
            className="absolute right-3 top-2.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('chat.clearSearch')}
          >
            <IconX size={16} />
          </button>
        )}
      </div>
    </div>
  );
};
