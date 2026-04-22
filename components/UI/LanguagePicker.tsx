'use client';

import { IconCheck, IconSearch, IconX } from '@tabler/icons-react';
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
  LanguageOption,
  filterLanguageOptions,
} from '@/lib/utils/app/languagePickerHelpers';

export interface LanguagePickerProps {
  /** Ref to the button that opens this picker. Used for click-outside + positioning. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Controls whether the dropdown is rendered. */
  isOpen: boolean;
  /** Fires when the dropdown should close (outside-click, Escape, or after a selection). */
  onClose: () => void;

  options: LanguageOption[];
  /** Currently-selected code, or null when nothing is selected. */
  value: string | null;
  /** Fires when a row is chosen. `null` signals the clearOption row. */
  onSelect: (code: string | null) => void;

  /**
   * A pinned row rendered above the list. Selecting it calls `onSelect(null)`.
   * Use for "auto-detect" / "show original" affordances.
   */
  clearOption?: { label: string } | null;
  /** Codes that show a green check on the right (e.g., previously cached). */
  cachedCodes?: Set<string>;
  /** Disables all rows (e.g., while a translation is in flight). */
  disabled?: boolean;

  searchPlaceholder?: string;
  ariaLabel?: string;
}

const DROPDOWN_WIDTH_PX = 256;
const OFFSET_PX = 8;

/**
 * Floating, searchable, keyboard-navigable language picker.
 *
 * Renders in a portal so it escapes clipped containers (file preview cards,
 * modals, etc.). Position is anchored to `triggerRef`, floating above it.
 */
export const LanguagePicker: FC<LanguagePickerProps> = ({
  triggerRef,
  isOpen,
  onClose,
  options,
  value,
  onSelect,
  clearOption = null,
  cachedCodes,
  disabled = false,
  searchPlaceholder,
  ariaLabel,
}) => {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredOptions = useMemo(
    () => filterLanguageOptions(options, searchQuery),
    [options, searchQuery],
  );

  const rowCount = filteredOptions.length + (clearOption ? 1 : 0);

  // Anchor the portal to the trigger.
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      let left = rect.right - DROPDOWN_WIDTH_PX;
      const top = rect.top - OFFSET_PX;
      if (left < OFFSET_PX) left = OFFSET_PX;
      setPosition({ top, left });
    }
  }, [isOpen, triggerRef]);

  // Focus the search input on open.
  useEffect(() => {
    if (!isOpen) return;
    const id = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [isOpen]);

  // Reset search + highlight when the dropdown closes.
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpenRef.current && !isOpen) {
      const id = setTimeout(() => {
        setSearchQuery('');
        setSelectedIndex(-1);
      }, 0);
      return () => clearTimeout(id);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // Close on outside click. Deferred one tick so the opening click doesn't
  // immediately re-close the dropdown.
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
    const id = setTimeout(
      () => document.addEventListener('mousedown', handleClickOutside),
      0,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on Escape (global, so it works even if focus has moved off the list).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSelect = useCallback(
    (code: string | null) => {
      if (disabled) return;
      onSelect(code);
      onClose();
    },
    [disabled, onSelect, onClose],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (rowCount === 0) return;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % rowCount);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + rowCount) % rowCount);
          break;
        case 'Enter': {
          event.preventDefault();
          if (selectedIndex < 0) return;
          if (clearOption && selectedIndex === 0) {
            handleSelect(null);
            return;
          }
          const optIndex = clearOption ? selectedIndex - 1 : selectedIndex;
          const opt = filteredOptions[optIndex];
          if (opt) handleSelect(opt.code);
          break;
        }
        case 'Escape':
          onClose();
          break;
      }
    },
    [
      rowCount,
      selectedIndex,
      clearOption,
      filteredOptions,
      handleSelect,
      onClose,
    ],
  );

  if (!isOpen) return null;
  if (typeof document === 'undefined') return null;

  const resolvedSearchPlaceholder =
    searchPlaceholder ?? t('chat.searchLanguages');
  const resolvedAriaLabel = ariaLabel ?? t('chat.selectLanguage');

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
      aria-label={resolvedAriaLabel}
      onKeyDown={handleKeyDown}
    >
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
            placeholder={resolvedSearchPlaceholder}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-white placeholder-gray-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label={t('common.clearSearch') || 'Clear search'}
            >
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto custom-scrollbar">
        {clearOption && (
          <>
            <button
              onClick={() => handleSelect(null)}
              disabled={disabled}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                selectedIndex === 0 ? 'bg-gray-100 dark:bg-gray-700' : ''
              }`}
              role="option"
              aria-selected={selectedIndex === 0}
            >
              <span className="font-medium text-blue-600 dark:text-blue-400">
                {clearOption.label}
              </span>
              {value === null && (
                <IconCheck size={14} className="text-blue-500" />
              )}
            </button>
            <div className="border-b border-gray-200 dark:border-gray-700" />
          </>
        )}

        {filteredOptions.map((opt, idx) => {
          const adjustedIndex = clearOption ? idx + 1 : idx;
          const isCached = cachedCodes?.has(opt.code) ?? false;
          const isSelected = opt.code === value;
          const isHighlighted = selectedIndex === adjustedIndex;
          const isUnsupported = opt.supported === false;

          return (
            <button
              key={opt.code}
              onClick={() => handleSelect(opt.code)}
              disabled={disabled}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isHighlighted ? 'bg-gray-100 dark:bg-gray-700' : ''
              } ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              role="option"
              aria-selected={isSelected}
              data-supported={isUnsupported ? 'false' : 'true'}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`font-medium truncate ${
                    isUnsupported
                      ? 'text-gray-400 dark:text-gray-500'
                      : 'text-gray-900 dark:text-white'
                  }`}
                >
                  {opt.label}
                </span>
                {opt.sublabel && (
                  <span
                    className={`text-xs truncate ${
                      isUnsupported
                        ? 'text-gray-400 dark:text-gray-600'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {opt.sublabel}
                  </span>
                )}
              </span>

              <span className="flex items-center gap-1 flex-shrink-0">
                {isSelected && (
                  <IconCheck size={14} className="text-blue-500" />
                )}
                {!isSelected && isCached && (
                  <IconCheck size={14} className="text-green-500" />
                )}
              </span>
            </button>
          );
        })}

        {filteredOptions.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('common.noResults')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default LanguagePicker;
