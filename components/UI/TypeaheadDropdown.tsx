'use client';

import { IconLoader2 } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import type {
  TypeaheadStatus,
  TypeaheadSuggestion,
} from '@/client/hooks/useTypeaheadSuggestions';

interface TypeaheadDropdownProps {
  /** id referenced by the input's aria-controls. */
  listId: string;
  suggestions: TypeaheadSuggestion[];
  status: TypeaheadStatus;
  activeIndex: number;
  onSelect: (value: string) => void;
  onHover: (index: number) => void;
  /** aria-label for the suggestion listbox. */
  listLabel?: string;
}

/**
 * Whether the dropdown has anything to show for the current typeahead
 * state. Callers use this for aria-expanded and to skip rendering.
 */
export function typeaheadDropdownOpen(
  status: TypeaheadStatus,
  suggestionCount: number,
): boolean {
  return suggestionCount > 0 || status !== 'idle';
}

/**
 * The shared suggestion dropdown under a typeahead input (EmailAutocomplete-
 * Input, ChipListInput). Three states, so the field never reads as plain
 * free-text while assistance exists:
 *
 * - searching (no results yet): a spinner row — visible from the first
 *   keystroke, while the debounce and fetch run. Typing is never blocked.
 * - results: the listbox (with a subtle spinner alongside while a NEWER
 *   query is still refreshing the list).
 * - done + empty: a "no directory matches" row, so silence after a search
 *   reads as an answer instead of a dead control.
 *
 * Failures drop the status back to 'idle' upstream, which unrenders the
 * dropdown entirely — a broken search never claims "no matches".
 */
export const TypeaheadDropdown: FC<TypeaheadDropdownProps> = ({
  listId,
  suggestions,
  status,
  activeIndex,
  onSelect,
  onHover,
  listLabel,
}) => {
  const t = useTranslations('peopleSuggest');
  if (!typeaheadDropdownOpen(status, suggestions.length)) return null;

  const frame =
    'absolute left-0 top-full z-20 mt-1 w-full min-w-[220px] rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800';

  if (suggestions.length === 0) {
    return (
      <div id={listId} role="status" className={`${frame} px-3 py-2`}>
        {status === 'searching' ? (
          <span className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <IconLoader2
              size={14}
              className="animate-spin text-blue-500"
              aria-hidden="true"
            />
            {t('searching')}
          </span>
        ) : (
          <span className="block text-sm text-gray-500 dark:text-gray-400">
            {t('noMatches')}
          </span>
        )}
      </div>
    );
  }

  return (
    <ul
      id={listId}
      role="listbox"
      aria-label={listLabel}
      aria-busy={status === 'searching'}
      className={`${frame} max-h-56 overflow-y-auto py-1`}
    >
      {status === 'searching' && (
        <li
          role="presentation"
          className="flex items-center gap-2 px-3 py-1 text-xs text-gray-400 dark:text-gray-500"
        >
          <IconLoader2
            size={12}
            className="animate-spin text-blue-500"
            aria-hidden="true"
          />
          {t('searching')}
        </li>
      )}
      {suggestions.map((person, index) => (
        <li
          key={person.value}
          id={`${listId}-option-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          // mousedown, not click: the input's blur fires first on click and
          // would clear the list before the click lands.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(person.value);
          }}
          onMouseEnter={() => onHover(index)}
          className={`cursor-pointer px-3 py-1.5 text-sm ${
            index === activeIndex ? 'bg-blue-50 dark:bg-blue-900/30' : ''
          }`}
        >
          <span className="block truncate text-gray-900 dark:text-gray-100">
            {person.label}
          </span>
          <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
            {person.value}
          </span>
        </li>
      ))}
    </ul>
  );
};
