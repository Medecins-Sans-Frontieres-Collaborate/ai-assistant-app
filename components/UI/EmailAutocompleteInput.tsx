'use client';

import { FC, InputHTMLAttributes, KeyboardEvent, useId } from 'react';

import {
  TypeaheadFetch,
  useTypeaheadSuggestions,
} from '@/client/hooks/useTypeaheadSuggestions';

import {
  TypeaheadDropdown,
  typeaheadDropdownOpen,
} from '@/components/UI/TypeaheadDropdown';

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
  const { suggestions, status, activeIndex, setActiveIndex, query, clear } =
    useTypeaheadSuggestions(suggest);
  const dropdownOpen = typeaheadDropdownOpen(status, suggestions.length);

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
        aria-expanded={suggest ? dropdownOpen : undefined}
        aria-autocomplete={suggest ? 'list' : undefined}
        aria-controls={suggest ? listId : undefined}
        aria-activedescendant={
          suggestions.length > 0 ? `${listId}-option-${activeIndex}` : undefined
        }
      />
      {suggest && (
        <TypeaheadDropdown
          listId={listId}
          suggestions={suggestions}
          status={status}
          activeIndex={activeIndex}
          onSelect={select}
          onHover={setActiveIndex}
          listLabel={suggestionsLabel}
        />
      )}
    </div>
  );
};
