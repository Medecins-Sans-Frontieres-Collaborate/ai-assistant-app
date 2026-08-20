'use client';

import { IconX } from '@tabler/icons-react';
import { FC, KeyboardEvent, useId, useState } from 'react';

import {
  TypeaheadFetch,
  useTypeaheadSuggestions,
} from '@/client/hooks/useTypeaheadSuggestions';

import {
  TypeaheadDropdown,
  typeaheadDropdownOpen,
} from '@/components/UI/TypeaheadDropdown';

interface ChipListInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addHint: string;
  /** aria-label prefix for chip remove buttons, e.g. "Remove". */
  removeLabel: string;
  /**
   * Optional per-entry normalizer applied to each comma-separated part of
   * the draft before dedupe/commit (e.g. stripping the local part off a
   * pasted email in a domains list).
   */
  normalize?: (value: string) => string;
  disabled?: boolean;
  /**
   * Optional suggestion source for the draft (e.g. useM365PeopleSuggest()
   * on email lists). Selecting a suggestion commits it as a chip directly.
   * Undefined keeps the input exactly as before.
   */
  suggest?: TypeaheadFetch;
  /** aria-label for the suggestion listbox (required when suggest is set). */
  suggestionsLabel?: string;
}

/**
 * Chip-style input for short string lists (allowed domains / user emails).
 * Enter, comma, or blur commits the current draft; a pasted comma-separated
 * list becomes one chip per entry. Empty parts and duplicates (compared
 * lowercased, matching the server's evaluation) are dropped silently.
 * With `suggest`, a typeahead dropdown offers completions for the draft:
 * ↑/↓ highlight, Enter/Tab commit the highlighted entry as a chip, Escape
 * dismisses and leaves plain-text entry untouched.
 */
export const ChipListInput: FC<ChipListInputProps> = ({
  values,
  onChange,
  placeholder,
  addHint,
  removeLabel,
  normalize,
  disabled = false,
  suggest,
  suggestionsLabel,
}) => {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const { suggestions, status, activeIndex, setActiveIndex, query, clear } =
    useTypeaheadSuggestions(suggest);
  const dropdownOpen = typeaheadDropdownOpen(status, suggestions.length);

  const commitDraft = () => {
    const parts = draft
      .split(',')
      .map((part) => (normalize ? normalize(part.trim()) : part).trim())
      .filter((part) => part.length > 0);
    setDraft('');
    if (parts.length === 0) return;
    const seen = new Set(values.map((v) => v.trim().toLowerCase()));
    const additions: string[] = [];
    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(part);
    }
    if (additions.length > 0) {
      onChange([...values, ...additions]);
    }
  };

  const commitSuggestion = (value: string) => {
    const key = value.trim().toLowerCase();
    if (!values.some((v) => v.trim().toLowerCase() === key)) {
      onChange([...values, value]);
    }
    setDraft('');
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
        commitSuggestion(suggestions[activeIndex].value);
        return;
      }
      if (e.key === 'Escape') {
        clear();
        return;
      }
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div
      className={`relative flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {values.map((value) => (
        <span
          key={value}
          className="flex items-center gap-1 rounded-full bg-gray-200 dark:bg-gray-700 px-2 py-0.5 text-xs text-black dark:text-white"
        >
          {value}
          {!disabled && (
            <button
              type="button"
              className="text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
              onClick={() => onChange(values.filter((v) => v !== value))}
              aria-label={`${removeLabel} ${value}`}
            >
              <IconX size={12} />
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        className="min-w-[140px] flex-1 border-none bg-transparent p-0.5 text-sm text-black outline-none placeholder:text-gray-400 dark:text-white dark:placeholder:text-gray-500"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          query(e.target.value, values);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          clear();
          commitDraft();
        }}
        placeholder={values.length === 0 ? placeholder : addHint}
        disabled={disabled}
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
          onSelect={commitSuggestion}
          onHover={setActiveIndex}
          listLabel={suggestionsLabel}
        />
      )}
    </div>
  );
};
