'use client';

import { IconX } from '@tabler/icons-react';
import { FC, KeyboardEvent, useId, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useAgentAccessGroupsEnabled } from '@/client/hooks/useAgentAccessGroupsEnabled';
import { rememberGroupName, useGroupNames } from '@/client/hooks/useGroupNames';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';
import {
  TypeaheadFetch,
  useTypeaheadSuggestions,
} from '@/client/hooks/useTypeaheadSuggestions';

import { searchEntraGroups } from '@/client/services/m365/m365Client';

import {
  Audience,
  audienceId,
  parseAudience,
} from '@/lib/utils/app/modelAccessGrid';

import { ADMIN_FIELD, ADMIN_HINT } from '@/components/Admin/adminClasses';
import { AudienceShape } from '@/components/Limits/visualSyntax';

interface AudiencePickerProps {
  /** The audiences picked so far, in the order they were added. */
  value: Audience[];
  onChange: (value: Audience[]) => void;
  /** Accessible name of the field. */
  label: string;
  disabled?: boolean;
}

/** Splits `scope:target` (a suggestion value) back into an audience. */
function audienceOfValue(value: string): Audience | null {
  const separator = value.indexOf(':');
  const scope = value.slice(0, separator);
  const target = value.slice(separator + 1);
  if (scope !== 'user' && scope !== 'group' && scope !== 'domain') return null;
  return target ? { scope, target } : null;
}

/**
 * ONE field for people, security groups and email domains together. Typing
 * searches the directory for people and groups at once; an email address or
 * a domain (`example.org`, `@example.org`) can simply be typed, and a pasted
 * comma-separated list becomes one chip per entry, whatever mix it holds.
 *
 * Enter, comma or leaving the field commits what was typed. Text that is
 * none of the three stays in the field with a message saying why, so a typo
 * is corrected instead of silently dropped. Directory search is a
 * convenience: when it is unavailable the field still takes typed entries.
 */
export const AudiencePicker: FC<AudiencePickerProps> = ({
  value,
  onChange,
  label,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const listId = useId();
  const messageId = useId();
  const [draft, setDraft] = useState('');
  const [rejected, setRejected] = useState<string | null>(null);
  const searchPeople = useM365PeopleSuggest();
  const groupsEnabled = useAgentAccessGroupsEnabled();
  const groupNames = useGroupNames(
    value.filter((a) => a.scope === 'group').map((a) => a.target),
  );

  const fetchSuggestions = useMemo<TypeaheadFetch | undefined>(() => {
    if (!searchPeople && !groupsEnabled) return undefined;
    return async (query, signal) => {
      // Each source fails on its own: no groups must not cost the people.
      const [groups, people] = await Promise.all([
        groupsEnabled ? searchEntraGroups(query).catch(() => []) : [],
        searchPeople ? searchPeople(query, signal).catch(() => []) : [],
      ]);
      for (const group of groups) rememberGroupName(group.id, group.name);
      return [
        ...groups.map((group) => ({
          label: group.name,
          value: audienceId({ scope: 'group', target: group.id }),
        })),
        ...people.map((person) => ({
          label: person.label,
          value: audienceId({ scope: 'user', target: person.value }),
        })),
      ];
    };
  }, [searchPeople, groupsEnabled]);
  const { suggestions, status, activeIndex, setActiveIndex, query, clear } =
    useTypeaheadSuggestions(fetchSuggestions);

  const add = (audiences: Audience[]) => {
    const seen = new Set(value.map(audienceId));
    const fresh = audiences.filter((audience) => {
      const id = audienceId(audience);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (fresh.length > 0) onChange([...value, ...fresh]);
  };

  /** Commits every recognisable entry in the draft; keeps the rest. */
  const commitDraft = () => {
    const parts = draft
      .split(/[,;\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const accepted: Audience[] = [];
    const refused: string[] = [];
    for (const part of parts) {
      const audience = parseAudience(part);
      if (audience && (audience.scope !== 'group' || groupsEnabled)) {
        accepted.push(audience);
      } else {
        refused.push(part);
      }
    }
    add(accepted);
    setDraft(refused.join(', '));
    setRejected(refused.length > 0 ? refused.join(', ') : null);
  };

  const commitSuggestion = (suggestionValue: string) => {
    const audience = audienceOfValue(suggestionValue);
    if (audience) add([audience]);
    setDraft('');
    setRejected(null);
    clear();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex(
          (activeIndex + step + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        commitSuggestion(suggestions[activeIndex].value);
        return;
      }
      if (event.key === 'Escape') {
        clear();
        return;
      }
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      clear();
      commitDraft();
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const nameOf = (audience: Audience): string =>
    audience.scope === 'group'
      ? (groupNames[audience.target] ?? audience.target)
      : audience.target;
  const open = suggestions.length > 0 || status !== 'idle';

  return (
    <div>
      <div
        // The chips and the text field share one box, drawn as the shared
        // admin field so it lines up with every other control on the page.
        className={`relative flex min-h-9 flex-wrap items-center gap-1.5 focus-within:ring-2 focus-within:ring-blue-500 ${ADMIN_FIELD} ${
          disabled ? 'opacity-50' : ''
        }`}
      >
        {value.map((audience) => (
          <span
            key={audienceId(audience)}
            className="flex items-center gap-1 rounded-full bg-gray-200 py-0.5 pe-2 ps-1 text-xs text-gray-900 dark:bg-gray-700 dark:text-white"
          >
            <AudienceShape kind={audience.scope} />
            <span className="sr-only">
              {t(`modelAccess.audience.kind.${audience.scope}`)}
            </span>
            <span className="[overflow-wrap:anywhere]">{nameOf(audience)}</span>
            {!disabled && (
              <button
                type="button"
                className="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                onClick={() =>
                  onChange(
                    value.filter(
                      (other) => audienceId(other) !== audienceId(audience),
                    ),
                  )
                }
                aria-label={t('modelAccess.removeGrant', {
                  target: nameOf(audience),
                })}
              >
                <IconX size={12} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        <input
          type="text"
          className="min-w-[14rem] flex-1 border-none bg-transparent p-0.5 text-sm text-gray-900 outline-none placeholder:text-gray-500 dark:text-white dark:placeholder:text-gray-400"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setRejected(null);
            query(event.target.value, value.map(audienceId));
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            clear();
            commitDraft();
          }}
          placeholder={
            value.length === 0 ? t('modelAccess.audience.placeholder') : ''
          }
          disabled={disabled}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-describedby={messageId}
          aria-invalid={rejected !== null}
          aria-activedescendant={
            suggestions.length > 0
              ? `${listId}-option-${activeIndex}`
              : undefined
          }
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            aria-busy={status === 'searching'}
            className="absolute start-0 top-full z-20 mt-1 max-h-60 w-full min-w-[16rem] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
          >
            {suggestions.length === 0 && (
              <li
                role="presentation"
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400"
              >
                {status === 'searching'
                  ? tPeople('searching')
                  : tPeople('noMatches')}
              </li>
            )}
            {suggestions.map((suggestion, index) => {
              const audience = audienceOfValue(suggestion.value);
              if (!audience) return null;
              return (
                <li
                  key={suggestion.value}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  // mousedown, not click: the field's blur fires first on a
                  // click and would close the list before the click lands.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commitSuggestion(suggestion.value);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm ${
                    index === activeIndex
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : ''
                  }`}
                >
                  <AudienceShape kind={audience.scope} />
                  <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">
                    {suggestion.label}
                  </span>
                  <span className="truncate text-xs text-gray-600 dark:text-gray-400">
                    {audience.scope === 'group'
                      ? t('modelAccess.audience.kind.group')
                      : audience.target}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p
        id={messageId}
        className={
          rejected === null
            ? ADMIN_HINT
            : 'mt-1 text-xs text-red-700 dark:text-red-300'
        }
        role={rejected === null ? undefined : 'alert'}
      >
        {rejected === null
          ? t(
              groupsEnabled
                ? 'modelAccess.audience.pickerHint'
                : 'modelAccess.audience.pickerHintNoGroups',
            )
          : t('modelAccess.audience.invalid', { text: rejected })}
      </p>
    </div>
  );
};
