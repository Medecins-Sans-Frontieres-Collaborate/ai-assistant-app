'use client';

import { IconCheck, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import React, {
  FC,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  /**
   * When set and the search query matches no option exactly, a trailing
   * "Add '<query>'" row is rendered; selecting it calls this with the raw
   * query (the caller creates the option and selects it). Used for
   * user-added translation languages.
   */
  onCreateOption?: (label: string) => void;
}

const DROPDOWN_WIDTH_PX = 256;
const OFFSET_PX = 8;
/** Search bar + capped list; used to decide above-vs-below placement. */
const DROPDOWN_EST_HEIGHT_PX = 330;

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
  onCreateOption,
}) => {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredOptions = useMemo(
    () => filterLanguageOptions(options, searchQuery),
    [options, searchQuery],
  );

  // "Add '<query>'" appears when creation is enabled, the query is
  // non-trivial, and no option matches it exactly (case-insensitive).
  const showCreateRow = useMemo(() => {
    if (!onCreateOption) return false;
    const query = searchQuery.trim();
    if (query.length < 2) return false;
    const lower = query.toLowerCase();
    return !options.some(
      (opt) =>
        opt.label.toLowerCase() === lower ||
        opt.sublabel?.toLowerCase() === lower,
    );
  }, [onCreateOption, searchQuery, options]);

  const rowCount = filteredOptions.length + (clearOption ? 1 : 0);

  // Anchor the portal to the trigger, flipping below when the space above
  // can't fit the dropdown (e.g. triggers near the top of the window) and
  // clamping horizontally to the viewport. Measured before paint and
  // re-computed on scroll/resize while open so the dropdown never drifts
  // off-screen (same pattern as Tooltip's multiline mode).
  useLayoutEffect(() => {
    if (!isOpen) return;

    const computePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();

      let left = rect.right - DROPDOWN_WIDTH_PX;
      left = Math.min(
        Math.max(left, OFFSET_PX),
        Math.max(window.innerWidth - DROPDOWN_WIDTH_PX - OFFSET_PX, OFFSET_PX),
      );

      const spaceAbove = rect.top - OFFSET_PX;
      const spaceBelow = window.innerHeight - rect.bottom - OFFSET_PX;
      const openAbove =
        spaceAbove >= DROPDOWN_EST_HEIGHT_PX || spaceAbove >= spaceBelow;

      setPlacement(openAbove ? 'above' : 'below');
      setPosition({
        top: openAbove ? rect.top - OFFSET_PX : rect.bottom + OFFSET_PX,
        left,
      });
    };

    computePosition();
    window.addEventListener('resize', computePosition);
    // Capture-phase scroll so scrolls inside nested containers reposition too.
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
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
      // Portaled to document.body, so containers with outside-click close
      // (notably SettingDialog) read clicks in here as "outside" and would
      // dismiss themselves mid-selection — unmounting the row before its
      // click handler runs. This marker is SettingDialog's opt-out contract
      // for its portaled children; inert everywhere else.
      data-settings-portal=""
      className="fixed z-[100] w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden animate-fade-in"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: placement === 'above' ? 'translateY(-100%)' : undefined,
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

        {onCreateOption && showCreateRow && (
          <button
            onClick={() => {
              onCreateOption(searchQuery.trim());
              onClose();
            }}
            disabled={disabled}
            className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 border-t border-gray-200 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            role="option"
            aria-selected={false}
          >
            <IconPlus size={14} className="shrink-0 text-blue-500" />
            <span className="truncate font-medium text-blue-600 dark:text-blue-400">
              {t('chat.addLanguageOption', { name: searchQuery.trim() })}
            </span>
          </button>
        )}

        {filteredOptions.length === 0 && !showCreateRow && (
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
