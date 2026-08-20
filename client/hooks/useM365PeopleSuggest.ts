import { useMemo } from 'react';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';
import type { TypeaheadFetch } from '@/client/hooks/useTypeaheadSuggestions';

import { searchPeople } from '@/client/services/m365/m365Client';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * M365 people autofill for email inputs: returns a TypeaheadFetch backed by
 * GET /api/m365/people/search (ranked contacts + org directory), or
 * `undefined` when the feature should not appear — the user is
 * disconnected, or no M365 capability is enabled in this environment.
 *
 * Pass the result straight to EmailAutocompleteInput / ChipListInput's
 * `suggest` prop; `undefined` renders them as plain inputs. Fetch failures
 * (consent gap, throttle, offline) surface as "no suggestions", never an
 * error — typing plain addresses always keeps working.
 */
export function useM365PeopleSuggest(): TypeaheadFetch | undefined {
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const { filesEnabled, mailEnabled, toolsEnabled, sharingEnabled } =
    useM365Enabled();
  const enabled =
    m365Connected &&
    (filesEnabled || mailEnabled || toolsEnabled || sharingEnabled);

  return useMemo<TypeaheadFetch | undefined>(() => {
    if (!enabled) return undefined;
    return async (query, signal) =>
      (await searchPeople(query, signal)).map((person) => ({
        label: person.displayName,
        value: person.email,
      }));
  }, [enabled]);
}
