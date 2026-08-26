'use client';

import { IconX } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useDelegatableAgents } from '@/client/hooks/useDelegatableAgents';

interface AgentKeyPickerProps {
  /** Selected canonical keys. */
  value: string[];
  onChange: (keys: string[]) => void;
  id?: string;
  /** Field classes from the surrounding admin page. */
  inputClassName?: string;
}

const MAX_SUGGESTIONS = 40;

/**
 * Multi-select for canonical agent keys with autocomplete over everything
 * an admin could delegate (agents, prompt / M365 / knowledge agents,
 * guides, connectors, datasets). Free text is still accepted — Enter adds
 * whatever was typed — so a key that isn't listed (another admin's, or a
 * freshly created one) can still be entered by hand.
 */
export const AgentKeyPicker: FC<AgentKeyPickerProps> = ({
  value,
  onChange,
  id,
  inputClassName,
}) => {
  const t = useTranslations('agentAccess');
  const { groups, nameByKey } = useDelegatableAgents({
    builtInLabel: t('localAdminBuiltIn'),
  });
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = useMemo(() => new Set(value), [value]);
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: {
      canonicalKey: string;
      displayName: string;
      detail?: string;
      group: string;
    }[] = [];
    for (const group of groups) {
      for (const option of group.options) {
        if (selected.has(option.canonicalKey)) continue;
        if (
          q &&
          !option.displayName.toLowerCase().includes(q) &&
          !option.canonicalKey.toLowerCase().includes(q) &&
          !(option.detail ?? '').toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push({ ...option, group: t(`localAdminGroup.${group.id}`) });
        if (out.length >= MAX_SUGGESTIONS) return out;
      }
    }
    return out;
  }, [groups, query, selected, t]);

  const add = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed || selected.has(trimmed)) return;
    onChange([...value, trimmed]);
    setQuery('');
    setActive(0);
  };
  const remove = (key: string) => onChange(value.filter((k) => k !== key));

  const listId = `${id ?? 'agent-key-picker'}-suggestions`;

  return (
    <div className="relative">
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1">
          {value.map((key) => (
            <li
              key={key}
              className="flex max-w-full items-center gap-1 rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              title={key}
            >
              <span className="truncate">{nameByKey.get(key) ?? key}</span>
              {nameByKey.has(key) && (
                <code className="hidden truncate font-mono text-[10px] text-gray-500 sm:inline dark:text-gray-400">
                  {key}
                </code>
              )}
              <button
                type="button"
                onClick={() => remove(key)}
                aria-label={t('agentKeyRemove', {
                  name: nameByKey.get(key) ?? key,
                })}
                className="shrink-0 rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-black dark:hover:bg-gray-700 dark:hover:text-white"
              >
                <IconX size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        className={inputClassName}
        placeholder={t('agentKeySearchPlaceholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) =>
              Math.min(a + 1, Math.max(0, suggestions.length - 1)),
            );
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && suggestions[active])
              add(suggestions[active].canonicalKey);
            else add(query);
          } else if (e.key === 'Escape') {
            setOpen(false);
          } else if (
            e.key === 'Backspace' &&
            query === '' &&
            value.length > 0
          ) {
            remove(value[value.length - 1]);
          }
        }}
      />
      {open && (suggestions.length > 0 || query.trim()) && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {suggestions.map((s, index) => (
            <li
              key={s.canonicalKey}
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s.canonicalKey);
              }}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1 ${
                index === active ? 'bg-gray-100 dark:bg-gray-800' : ''
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-black dark:text-white">
                {s.displayName}
              </span>
              <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                {s.group}
              </span>
              <code className="hidden max-w-[40%] truncate font-mono text-[10px] text-gray-400 md:inline">
                {s.canonicalKey}
              </code>
            </li>
          ))}
          {query.trim() &&
            !suggestions.some((s) => s.canonicalKey === query.trim()) && (
              <li
                role="option"
                aria-selected={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(query);
                }}
                className="cursor-pointer px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {t('agentKeyAddCustom', { key: query.trim() })}
              </li>
            )}
        </ul>
      )}
    </div>
  );
};
