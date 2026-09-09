'use client';

import { IconCheck, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  SearchableListOption,
  filterSearchableOptions,
  shouldOfferCreate,
} from '@/lib/utils/app/searchableListPicker';

export interface SearchableListPickerOption extends SearchableListOption {
  /** Optional leading icon for the row. */
  icon?: ReactNode;
}

export interface SearchableListPickerProps {
  /** The element the picker is anchored to (also exempt from outside-click). */
  triggerRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  /** Fires on outside click, Escape, or after a selection. */
  onClose: () => void;

  options: SearchableListPickerOption[];
  /** Currently selected id, or null when nothing / the clear row is selected. */
  value: string | null;
  /** `null` signals the clear row. */
  onSelect: (id: string | null) => void;

  /** A pinned row above the list; selecting it calls `onSelect(null)`. */
  clearOption?: { label: string; icon?: ReactNode } | null;

  searchPlaceholder: string;
  /** aria-label for the listbox. */
  ariaLabel: string;
  noResultsLabel: string;
  /** aria-label for the × that clears the search query. */
  clearSearchLabel?: string;
  /**
   * Render the search box only when there are at least this many options.
   * Short lists then look like a plain menu. Defaults to 0 (always shown).
   */
  searchThreshold?: number;
  /**
   * When set and the query matches no option exactly, a trailing create row
   * is rendered; selecting it calls this with the trimmed query. The caller
   * creates the option and (typically) selects it.
   */
  onCreateOption?: (label: string) => void;
  /** Label for the create row given the trimmed query. */
  createLabel?: (query: string) => string;

  /** Which trigger edge the picker aligns to. Defaults to the right edge. */
  align?: 'left' | 'right';
  widthPx?: number;
}

const DEFAULT_WIDTH_PX = 256;
const GAP_PX = 4;
const VIEWPORT_INSET_PX = 8;

// useLayoutEffect logs a warning on the server. Fall back to useEffect when
// there is no DOM (SSR pass); the portal renders nothing then anyway.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Floating, searchable, keyboard-navigable single-select list.
 *
 * Portaled to `document.body` so it escapes clipped/scrolling containers,
 * anchored to `triggerRef`, placed below the trigger and flipped above when
 * there is not enough room. Placement is re-run whenever the picker's own
 * size changes (filtering shrinks the list, the create row appears), so it
 * never runs off the viewport.
 *
 * The root stops `click` propagation: React bubbles portal events through
 * the *component* tree, so without this a click on a row would also fire
 * the `onClick` of whatever list item rendered the picker.
 */
export const SearchableListPicker: FC<SearchableListPickerProps> = ({
  triggerRef,
  isOpen,
  onClose,
  options,
  value,
  onSelect,
  clearOption = null,
  searchPlaceholder,
  ariaLabel,
  noResultsLabel,
  clearSearchLabel,
  searchThreshold = 0,
  onCreateOption,
  createLabel,
  align = 'right',
  widthPx = DEFAULT_WIDTH_PX,
}) => {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const showSearch = options.length >= searchThreshold;
  const filtered = useMemo(
    () => filterSearchableOptions(options, query),
    [options, query],
  );
  const showCreateRow =
    Boolean(onCreateOption) && shouldOfferCreate(options, query);

  // Row indices: [clear?] [...filtered] [create?]
  const clearOffset = clearOption ? 1 : 0;
  const rowCount = clearOffset + filtered.length + (showCreateRow ? 1 : 0);

  // Every close path goes through here so the next open starts clean.
  const close = useCallback(() => {
    setQuery('');
    setHighlight(-1);
    onClose();
  }, [onClose]);

  // Focus the search box (or the list) once the portal has mounted.
  useEffect(() => {
    if (!isOpen) return;
    const id = setTimeout(() => {
      (searchInputRef.current ?? rootRef.current)?.focus();
    }, 30);
    return () => clearTimeout(id);
  }, [isOpen]);

  // Anchor + flip + clamp; re-run on scroll/resize and on own size change.
  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;

    const compute = () => {
      const trigger = triggerRef.current;
      const root = rootRef.current;
      if (!trigger || !root) return;
      const rect = trigger.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const spaceBelow = vh - rect.bottom - GAP_PX;
      const spaceAbove = rect.top - GAP_PX;
      const below = box.height <= spaceBelow || spaceBelow >= spaceAbove;
      const rawTop = below
        ? rect.bottom + GAP_PX
        : rect.top - GAP_PX - box.height;
      const maxTop = Math.max(
        VIEWPORT_INSET_PX,
        vh - box.height - VIEWPORT_INSET_PX,
      );
      const top = Math.min(Math.max(rawTop, VIEWPORT_INSET_PX), maxTop);

      const rawLeft = align === 'right' ? rect.right - widthPx : rect.left;
      const maxLeft = Math.max(
        VIEWPORT_INSET_PX,
        vw - widthPx - VIEWPORT_INSET_PX,
      );
      const left = Math.min(Math.max(rawLeft, VIEWPORT_INSET_PX), maxLeft);

      setPosition({ top, left });
    };

    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && rootRef.current) {
      observer = new ResizeObserver(() => compute());
      observer.observe(rootRef.current);
    }
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
      observer?.disconnect();
    };
  }, [isOpen, triggerRef, align, widthPx]);

  // Outside click (deferred a tick so the opening click doesn't close it).
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    const id = setTimeout(
      () => document.addEventListener('mousedown', onMouseDown),
      0,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [isOpen, close, triggerRef]);

  const choose = useCallback(
    (id: string | null) => {
      onSelect(id);
      close();
    },
    [onSelect, close],
  );

  const create = useCallback(() => {
    if (!onCreateOption) return;
    onCreateOption(query.trim());
    close();
  }, [onCreateOption, query, close]);

  const activateRow = useCallback(
    (index: number) => {
      if (index < 0 || index >= rowCount) return;
      if (clearOption && index === 0) return choose(null);
      const optIndex = index - clearOffset;
      if (optIndex < filtered.length) return choose(filtered[optIndex].id);
      if (showCreateRow) create();
    },
    [
      rowCount,
      clearOption,
      clearOffset,
      filtered,
      showCreateRow,
      choose,
      create,
    ],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (rowCount) setHighlight((h) => (h + 1) % rowCount);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (rowCount) setHighlight((h) => (h - 1 + rowCount) % rowCount);
        break;
      case 'Enter':
        event.preventDefault();
        // With nothing highlighted, Enter picks the only match (or creates).
        if (highlight >= 0) activateRow(highlight);
        else if (filtered.length === 1 && !clearOption) choose(filtered[0].id);
        else if (filtered.length === 0 && showCreateRow) create();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
    }
  };

  if (!isOpen || typeof document === 'undefined') return null;

  const rowClass = (active: boolean, selected: boolean) =>
    `flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
      active ? 'bg-gray-100 dark:bg-gray-700' : ''
    } ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`;

  return createPortal(
    <div
      ref={rootRef}
      // SettingDialog's outside-click opt-out for portaled children.
      data-settings-portal=""
      data-searchable-list-picker=""
      tabIndex={-1}
      className="fixed z-[110] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg outline-none animate-fade-in dark:border-gray-700 dark:bg-gray-800"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${widthPx}px`,
      }}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {showSearch && (
        <div className="border-b border-gray-200 p-2 dark:border-gray-700">
          <div className="relative">
            <IconSearch
              size={16}
              aria-hidden
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(-1);
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              className="w-full rounded-md border-0 bg-gray-100 py-1.5 pl-8 pr-8 text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                aria-label={clearSearchLabel ?? 'Clear'}
              >
                <IconX size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      <div
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        className="custom-scrollbar max-h-64 overflow-y-auto py-1"
      >
        {clearOption && (
          <>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => choose(null)}
              onMouseEnter={() => setHighlight(0)}
              className={rowClass(highlight === 0, false)}
            >
              <span className="flex min-w-0 items-center gap-2 font-medium text-gray-900 dark:text-white">
                {clearOption.icon}
                <span className="truncate">{clearOption.label}</span>
              </span>
              {value === null && (
                <IconCheck size={14} className="shrink-0 text-blue-500" />
              )}
            </button>
            <div className="my-1 border-b border-gray-200 dark:border-gray-700" />
          </>
        )}

        {filtered.map((opt, i) => {
          const index = i + clearOffset;
          const selected = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => choose(opt.id)}
              onMouseEnter={() => setHighlight(index)}
              className={rowClass(highlight === index, selected)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {opt.icon}
                <span className="truncate font-medium text-gray-900 dark:text-white">
                  {opt.label}
                </span>
                {opt.sublabel && (
                  <span className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {opt.sublabel}
                  </span>
                )}
              </span>
              {selected && (
                <IconCheck size={14} className="shrink-0 text-blue-500" />
              )}
            </button>
          );
        })}

        {showCreateRow && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={create}
            onMouseEnter={() => setHighlight(rowCount - 1)}
            className={`${rowClass(highlight === rowCount - 1, false)} border-t border-gray-200 dark:border-gray-700`}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium text-blue-600 dark:text-blue-400">
              <IconPlus size={14} className="shrink-0" />
              <span className="truncate">
                {createLabel ? createLabel(query.trim()) : query.trim()}
              </span>
            </span>
          </button>
        )}

        {filtered.length === 0 && !showCreateRow && (
          <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {noResultsLabel}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
