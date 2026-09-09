'use client';

import { FC, useEffect, useRef, useState } from 'react';

import { useAgentAccessGroupsEnabled } from '@/client/hooks/useAgentAccessGroupsEnabled';

import {
  M365GroupEntry,
  M365_SEARCH_DEBOUNCE_MS,
  M365_SEARCH_MIN_CHARS,
  lookupEntraGroups,
  searchEntraGroups,
} from '@/client/services/m365/m365Client';

import { ChipListInput } from './ChipListInput';

interface GroupSearchPickerLabels {
  searchPlaceholder: string;
  searchHint: string;
  noResults: string;
  searchError: string;
  chipPlaceholder: string;
  addHint: string;
  removeLabel: string;
  /** Shown when the agentAccessGroups flag is off (read-only fallback). */
  flagOffHint: string;
}

interface GroupSearchPickerProps {
  /**
   * Entra group OBJECT IDS — this is the persisted wire value; display
   * names are a lookup-time convenience that never round-trips.
   */
  values: string[];
  onChange: (values: string[]) => void;
  labels: GroupSearchPickerLabels;
  disabled?: boolean;
}

type SearchState = 'idle' | 'loading' | 'done' | 'error';

/**
 * Entra group typeahead + id chip list for the admin rule/override editors.
 *
 * The chip list holds raw object ids (pasteable directly — the rule schema
 * stores ids, and an admin may know one the search can't reach). Picking a
 * search result adds its id chip and remembers id→displayName in local state,
 * so freshly added chips can be captioned "name (id-prefix…)"; chips loaded
 * from storage have no name available and render the raw id only.
 */
export const GroupSearchPicker: FC<GroupSearchPickerProps> = ({
  values,
  onChange,
  labels,
  disabled = false,
}) => {
  const flagEnabled = useAgentAccessGroupsEnabled();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<M365GroupEntry[]>([]);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [namesById, setNamesById] = useState<Record<string, string>>({});
  const lookedUpRef = useRef(false);

  // Fresh names for chips loaded from storage, resolved once per mount —
  // names never persist, so drifted group renames are always current here.
  useEffect(() => {
    if (lookedUpRef.current || values.length === 0) return;
    lookedUpRef.current = true;
    let cancelled = false;
    void lookupEntraGroups(values)
      .then((groups) => {
        if (cancelled || groups.length === 0) return;
        setNamesById((prev) => ({
          ...prev,
          ...Object.fromEntries(groups.map((g) => [g.id, g.name])),
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sub-minimum queries are reset in the change handler (not the effect) so
  // the effect never sets state synchronously; it only schedules the search.
  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim().length < M365_SEARCH_MIN_CHARS) {
      setResults([]);
      setSearchState('idle');
    }
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < M365_SEARCH_MIN_CHARS) return;
    // Debounced + cancellation-guarded: only the latest query's response may
    // update state, or a slow earlier search overwrites newer results.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchState('loading');
      try {
        const found = await searchEntraGroups(trimmed);
        if (cancelled) return;
        setResults(found);
        setSearchState('done');
      } catch {
        if (cancelled) return;
        setResults([]);
        setSearchState('error');
      }
    }, M365_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const addGroup = (group: M365GroupEntry) => {
    setNamesById((prev) => ({ ...prev, [group.id]: group.name }));
    if (!values.includes(group.id)) {
      onChange([...values, group.id]);
    }
    setQuery('');
    setResults([]);
    setSearchState('idle');
  };

  const namedChips = values.filter((id) => namesById[id]);

  // Flag off: existing group targets stay visible (they still evaluate
  // server-side) but the editing surface is hidden.
  if (!flagEnabled) {
    if (values.length === 0) return null;
    return (
      <div>
        <ChipListInput
          values={values}
          onChange={() => undefined}
          placeholder=""
          addHint=""
          removeLabel={labels.removeLabel}
          disabled
        />
        {namedChips.length > 0 && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {namedChips
              .map((id) => `${namesById[id]} (${id.slice(0, 8)}…)`)
              .join(' · ')}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {labels.flagOffHint}
        </p>
      </div>
    );
  }

  return (
    <div>
      <input
        type="text"
        className="mb-1.5 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-black outline-none placeholder:text-gray-400 dark:text-white dark:placeholder:text-gray-500"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder={labels.searchPlaceholder}
        aria-label={labels.searchPlaceholder}
        disabled={disabled}
      />
      {searchState === 'done' && results.length > 0 && (
        <ul className="mb-1.5 max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {results.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-sm text-black hover:bg-gray-100 dark:text-white dark:hover:bg-gray-700"
                onClick={() => addGroup(group)}
              >
                <span>{group.name}</span>
                <span className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {group.id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchState === 'done' && results.length === 0 && (
        <p className="mb-1.5 text-xs text-gray-500 dark:text-gray-400">
          {labels.noResults}
        </p>
      )}
      {searchState === 'error' && (
        <p className="mb-1.5 text-xs text-red-600 dark:text-red-400">
          {labels.searchError}
        </p>
      )}
      <ChipListInput
        values={values}
        onChange={onChange}
        placeholder={labels.chipPlaceholder}
        addHint={labels.addHint}
        removeLabel={labels.removeLabel}
        disabled={disabled}
      />
      {namedChips.length > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {namedChips
            .map((id) => `${namesById[id]} (${id.slice(0, 8)}…)`)
            .join(' · ')}
        </p>
      )}
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {labels.searchHint}
      </p>
    </div>
  );
};
