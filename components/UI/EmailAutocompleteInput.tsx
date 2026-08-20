'use client';

import { FC, InputHTMLAttributes, KeyboardEvent, useId } from 'react';

import {
  TypeaheadFetch,
  useTypeaheadSuggestions,
} from '@/client/hooks/useTypeaheadSuggestions';

interface EmailAutocompleteInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
> {
  value: string;
  onChange: (value: string) => void;
  /**
   * Suggestion source (usually useM365PeopleSuggest()). Undefined renders a
   * plain input — the component never gates itself, callers decide.
   */
  suggest?: TypeaheadFetch;
  /** aria-label for the suggestion listbox (required when suggest is set). */
  suggestionsLabel?: string;
  /**
   * Called when a suggestion is picked; defaults to onChange(email). Use to
   * commit immediately (e.g. add straight to a list instead of filling the
   * field).
   */
  onSelectSuggestion?: (email: string) => void;
}

/**
 * A single-email text input with optional people autocomplete. Suggestions
 * drop down under the field; ↑/↓ move the highlight, Enter/Tab select,
 * Escape dismisses. With no suggestions visible, keys behave exactly like a
 * plain input (Enter still submits an enclosing form), so wiring this in is
 * behavior-preserving for users without the suggestion source.
 */
export const EmailAutocompleteInput: FC<EmailAutocompleteInputProps> = ({
  value,
  onChange,
  suggest,
  suggestionsLabel,
  onSelectSuggestion,
  onKeyDown,
  onBlur,
  ...inputProps
}) => {
  const listId = useId();
  const { suggestions, activeIndex, setActiveIndex, query, clear } =
    useTypeaheadSuggestions(suggest);

  const select = (email: string) => {
    if (onSelectSuggestion) onSelectSuggestion(email);
    else onChange(email);
    clear();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((activeIndex + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(
          (activeIndex - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        select(suggestions[activeIndex].value);
        return;
      }
      if (e.key === 'Escape') {
        clear();
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        {...inputProps}
        type={inputProps.type ?? 'email'}
        className={`w-full ${inputProps.className ?? ''}`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          query(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          clear();
          onBlur?.(e);
        }}
        role={suggest ? 'combobox' : undefined}
        aria-expanded={suggest ? suggestions.length > 0 : undefined}
        aria-autocomplete={suggest ? 'list' : undefined}
        aria-controls={suggest ? listId : undefined}
        aria-activedescendant={
          suggestions.length > 0 ? `${listId}-option-${activeIndex}` : undefined
        }
      />
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={suggestionsLabel}
          className="absolute z-20 mt-1 max-h-56 w-full min-w-[220px] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {suggestions.map((person, index) => (
            <li
              key={person.value}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown, not click: the input's blur fires first on click
              // and would clear the list before the click lands.
              onMouseDown={(e) => {
                e.preventDefault();
                select(person.value);
              }}
              onMouseEnter={() => setActiveIndex(index)}
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
      )}
    </div>
  );
};
