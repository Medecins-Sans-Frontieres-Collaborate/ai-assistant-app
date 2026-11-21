import { IconFolder } from '@tabler/icons-react';
import { FC, MutableRefObject, useEffect } from 'react';

import { useTranslations } from 'next-intl';

import { groupPromptsForList } from '@/lib/utils/shared/chat/promptMatching';
import {
  getVariableDefinitions,
  humanizeVariableName,
} from '@/lib/utils/shared/chat/variables';

import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';

interface Props {
  /** Prompts to offer; shown grouped by folder (groupPromptsForList). */
  prompts: Prompt[];
  /** Position, in the list's order, of the highlighted prompt. */
  activePromptIndex: number;
  /** Uses the prompt at a position of the list. */
  onSelect: (index: number) => void;
  onMouseOver: (index: number) => void;
  promptListRef: MutableRefObject<HTMLUListElement | null>;
  folders?: FolderInterface[];
  /** Id of the list, for the message box's aria-controls. */
  id?: string;
}

/** Id of the option at a position, for aria-activedescendant. */
export const promptOptionId = (listId: string, index: number): string =>
  `${listId}-option-${index}`;

/**
 * The prompts offered while typing "/": a listbox the message box drives
 * (arrows move, Enter uses, Escape closes; see usePromptSelection), grouped
 * by folder. Each prompt shows its description and the fields it will ask
 * for, so the right one can be told apart before choosing it.
 */
export const PromptList: FC<Props> = ({
  prompts,
  activePromptIndex,
  onSelect,
  onMouseOver,
  promptListRef,
  folders = [],
  id = 'prompt-list',
}) => {
  const t = useTranslations();
  const { groups } = groupPromptsForList(prompts, folders);

  // The highlighted prompt stays in sight as the arrows move.
  useEffect(() => {
    promptListRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activePromptIndex, promptListRef]);

  // Where each group's first prompt sits in the list's order.
  const starts = groups.map((_, at) =>
    groups.slice(0, at).reduce((sum, group) => sum + group.prompts.length, 0),
  );
  return (
    <ul
      ref={promptListRef}
      id={id}
      role="listbox"
      aria-label={t('Prompts')}
      className="max-h-80 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl animate-fade-in-fast dark:border-gray-700 dark:bg-surface-dark dark:text-white"
    >
      {groups.map((group, groupAt) => (
        <li key={group.folder?.id ?? 'no-folder'} role="presentation">
          {group.folder && (
            <div
              aria-hidden
              className="sticky top-0 z-10 flex items-center gap-2 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            >
              <IconFolder size={14} />
              {group.folder.name}
            </div>
          )}
          <ul role="presentation">
            {group.prompts.map((prompt, at) => {
              const index = starts[groupAt] + at;
              const isActive = index === activePromptIndex;
              const fields = getVariableDefinitions(prompt.content).map(
                (definition) => humanizeVariableName(definition.name),
              );
              return (
                <li
                  key={prompt.id}
                  id={promptOptionId(id, index)}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(index);
                  }}
                  onMouseEnter={() => onMouseOver(index)}
                  className={`cursor-pointer px-3 py-2 text-sm ${
                    isActive
                      ? 'bg-blue-100 dark:bg-blue-900/40'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                  }`}
                >
                  <div className="truncate font-medium text-gray-900 dark:text-gray-100">
                    {prompt.name}
                  </div>
                  {prompt.description && (
                    <div className="truncate text-xs text-gray-600 dark:text-gray-400">
                      {prompt.description}
                    </div>
                  )}
                  {fields.length > 0 && (
                    <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {t('promptList.asksFor', { fields: fields.join(', ') })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
      <li
        role="presentation"
        aria-hidden
        className="mt-1 border-t border-gray-100 px-3 pt-1.5 pb-0.5 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400"
      >
        {t('promptList.keysHint')}
      </li>
    </ul>
  );
};
