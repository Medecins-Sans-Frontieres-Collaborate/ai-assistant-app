'use client';

import { IconCheck, IconLoader2, IconSearch, IconX } from '@tabler/icons-react';
import React, {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import {
  getAutonym,
  getSupportedLocales,
  localeToAutonym,
} from '@/lib/utils/app/locales';

interface TranslationDropdownProps {
  /** Reference to the button that triggered the dropdown */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Callback to close the dropdown */
  onClose: () => void;
  /** Callback when a language is selected (null = show original) */
  onSelectLanguage: (locale: string | null) => void;
  /** Currently displayed locale (null = showing original) */
  currentLocale: string | null;
  /** Whether a translation is in progress */
  isTranslating: boolean;
  /** Set of locale codes that have been cached */
  cachedLocales: Set<string>;
}

/**
 * Dropdown component for selecting a target language for translation.
 * Features search filtering, cached language indicators, and "Show Original" option.
 */
export const TranslationDropdown: FC<TranslationDropdownProps> = ({
  triggerRef,
  isOpen,
  onClose,
  onSelectLanguage,
  currentLocale,
  isTranslating,
  cachedLocales,
}) => {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Get sorted languages
  const allLocales = useMemo(() => {
    return getSupportedLocales().sort((a, b) => {
      const nameA = getAutonym(a).toLowerCase();
      const nameB = getAutonym(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, []);

  // Filter languages based on search query
  const filteredLocales = useMemo(() => {
    if (!searchQuery.trim()) return allLocales;

    const query = searchQuery.toLowerCase();
    return allLocales.filter((locale) => {
      const autonym = getAutonym(locale).toLowerCase();
      return autonym.includes(query) || locale.includes(query);
    });
  }, [allLocales, searchQuery]);

  // Calculate position based on trigger element
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const dropdownWidth = 256; // w-64 = 16rem = 256px

      // Position above the button by default, align right edge with button
      let left = triggerRect.right - dropdownWidth;
      const top = triggerRect.top - 8; // 8px gap above

      // Ensure dropdown doesn't go off-screen to the left
      if (left < 8) {
        left = 8;
      }

      setPosition({ top, left });
    }
  }, [isOpen, triggerRef]);

  // Focus search input when dropdown opens and reset state when closed
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready
      const timeoutId = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [isOpen]);

  // Reset state when dropdown closes (using a ref to track previous state)
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpenRef.current && !isOpen) {
      // Dropdown just closed - schedule reset
      const timeoutId = setTimeout(() => {
        setSearchQuery('');
        setSelectedIndex(-1);
      }, 0);
      return () => clearTimeout(timeoutId);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    // Add small delay to prevent immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const items = currentLocale
        ? filteredLocales.length + 1
        : filteredLocales.length;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % items);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + items) % items);
          break;
        case 'Enter':
          event.preventDefault();
          if (selectedIndex >= 0) {
            if (currentLocale && selectedIndex === 0) {
              onSelectLanguage(null);
            } else {
              const localeIndex = currentLocale
                ? selectedIndex - 1
                : selectedIndex;
              if (filteredLocales[localeIndex]) {
                onSelectLanguage(filteredLocales[localeIndex]);
              }
            }
            onClose();
          }
          break;
        case 'Escape':
          onClose();
          break;
      }
    },
    [currentLocale, filteredLocales, selectedIndex, onSelectLanguage, onClose],
  );

  const handleLanguageSelect = useCallback(
    (locale: string | null) => {
      onSelectLanguage(locale);
      onClose();
    },
    [onSelectLanguage, onClose],
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-[100] w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden animate-fade-in"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: 'translateY(-100%)',
      }}
      role="listbox"
      aria-label={t('chat.selectLanguage')}
      onKeyDown={handleKeyDown}
    >
      {/* Search input */}
      <div className="p-2 border-b border-gray-200 dark:border-gray-700">
        <div className="relative">
          <IconSearch
            size={16}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('chat.searchLanguages')}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-white placeholder-gray-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Language list */}
      <div className="max-h-64 overflow-y-auto custom-scrollbar">
        {/* Show Original option (only when translation is active) */}
        {currentLocale && (
          <>
            <button
              onClick={() => handleLanguageSelect(null)}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                selectedIndex === 0 ? 'bg-gray-100 dark:bg-gray-700' : ''
              }`}
              role="option"
              aria-selected={selectedIndex === 0}
            >
              <span className="font-medium text-blue-600 dark:text-blue-400">
                {t('chat.showOriginal')}
              </span>
            </button>
            <div className="border-b border-gray-200 dark:border-gray-700" />
          </>
        )}

        {/* Language options */}
        {filteredLocales.map((locale, index) => {
          const adjustedIndex = currentLocale ? index + 1 : index;
          const isCached = cachedLocales.has(locale);
          const isSelected = locale === currentLocale;
          const isHighlighted = selectedIndex === adjustedIndex;

          return (
            <button
              key={locale}
              onClick={() => handleLanguageSelect(locale)}
              disabled={isTranslating}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isHighlighted ? 'bg-gray-100 dark:bg-gray-700' : ''
              } ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              role="option"
              aria-selected={isSelected}
            >
              <span className="flex items-center gap-2">
                <span className="font-medium text-gray-900 dark:text-white">
                  {getAutonym(locale)}
                </span>
                <span className="text-gray-500 dark:text-gray-400 text-xs">
                  {locale}
                </span>
              </span>

              {/* Status indicators */}
              <span className="flex items-center gap-1">
                {isTranslating && isSelected && (
                  <IconLoader2
                    size={14}
                    className="animate-spin text-blue-500"
                  />
                )}
                {!isTranslating && isSelected && (
                  <IconCheck size={14} className="text-blue-500" />
                )}
                {!isSelected && isCached && (
                  <IconCheck size={14} className="text-green-500" />
                )}
              </span>
            </button>
          );
        })}

        {/* No results */}
        {filteredLocales.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('common.noResults')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default TranslationDropdown;
