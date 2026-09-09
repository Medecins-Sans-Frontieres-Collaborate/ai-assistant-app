import { useCallback, useEffect, useRef, useState } from 'react';

import {
  M365_SEARCH_DEBOUNCE_MS,
  M365_SEARCH_MIN_CHARS,
} from '@/client/services/m365/m365Client';

/** One selectable suggestion: what's shown vs. what's inserted. */
export interface TypeaheadSuggestion {
  /** Primary display line (e.g. a person's name). */
  label: string;
  /** The value inserted on selection (e.g. the email address). */
  value: string;
}

/**
 * Fetches suggestions for an in-progress query. Implementations must treat
 * failures as "no suggestions" upstream concerns: this hook swallows
 * rejections (typing plain text must keep working when suggestions break).
 */
export type TypeaheadFetch = (
  query: string,
  signal: AbortSignal,
) => Promise<TypeaheadSuggestion[]>;

/**
 * Where the typeahead currently stands, for user-visible feedback:
 * - 'idle'      — nothing to show (token too short, cleared, or a failure)
 * - 'searching' — a fetch is debouncing or in flight (show a busy row so the
 *                 field reads as assisted, not free-text)
 * - 'done'      — a fetch completed; `suggestions` holds the (possibly
 *                 empty) answer, so an empty list means "no matches", not
 *                 "nothing happened"
 */
export type TypeaheadStatus = 'idle' | 'searching' | 'done';

/**
 * Debounced, abortable suggestion state for a typeahead input — the shared
 * machinery behind the M365 people autofill (and any future suggestion
 * source). Pass `undefined` as the fetcher to disable entirely: `query`
 * becomes a no-op and `suggestions` stays empty, so callers can gate on
 * feature flags without conditional hook calls.
 *
 * Suggestions are always a convenience: fetch failures resolve to an empty
 * list and the status drops back to 'idle' — a broken search must read as
 * "no assistance", never as a confident "no matches".
 */
export function useTypeaheadSuggestions(fetchSuggestions?: TypeaheadFetch): {
  suggestions: TypeaheadSuggestion[];
  status: TypeaheadStatus;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /**
   * Debounce-fetch suggestions for the current token. Values in `exclude`
   * (compared lowercased) are filtered out — pass already-selected entries
   * so they don't resurface. Tokens shorter than the minimum clear the list.
   */
  query: (token: string, exclude?: string[]) => void;
  /** Abort any in-flight fetch and hide the list. */
  clear: () => void;
} {
  const [suggestions, setSuggestions] = useState<TypeaheadSuggestion[]>([]);
  const [status, setStatus] = useState<TypeaheadStatus>('idle');
  const [activeIndex, setActiveIndex] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSuggestions([]);
    setStatus('idle');
    setActiveIndex(0);
  }, []);

  const query = useCallback(
    (token: string, exclude?: string[]) => {
      abortRef.current?.abort();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const trimmed = token.trim();
      if (!fetchSuggestions || trimmed.length < M365_SEARCH_MIN_CHARS) {
        setSuggestions([]);
        setStatus('idle');
        setActiveIndex(0);
        return;
      }
      // Busy from the first keystroke, not from when the debounce fires —
      // the whole point of the status is that the user sees the search
      // exists while they are still typing.
      setStatus('searching');
      timerRef.current = window.setTimeout(() => {
        const controller = new AbortController();
        abortRef.current = controller;
        fetchSuggestions(trimmed, controller.signal)
          .then((results) => {
            if (controller.signal.aborted) return;
            const excluded = new Set(
              (exclude ?? []).map((value) => value.trim().toLowerCase()),
            );
            setSuggestions(
              results.filter((s) => !excluded.has(s.value.toLowerCase())),
            );
            setStatus('done');
            setActiveIndex(0);
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            // Failure = quietly unassisted, not "no matches".
            setSuggestions([]);
            setStatus('idle');
          });
      }, M365_SEARCH_DEBOUNCE_MS);
    },
    [fetchSuggestions],
  );

  // Abort any pending work when the consuming component unmounts.
  useEffect(() => clear, [clear]);

  return { suggestions, status, activeIndex, setActiveIndex, query, clear };
}
