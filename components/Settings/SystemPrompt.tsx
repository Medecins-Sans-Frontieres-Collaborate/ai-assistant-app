import { IconX } from '@tabler/icons-react';
import { FC, KeyboardEvent, useEffect, useRef, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { usePromptSelection } from '@/client/hooks/ui/usePromptSelection';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';
import { replacePromptTrigger } from '@/lib/utils/shared/chat/promptMatching';
import { replaceVariablesWithMap } from '@/lib/utils/shared/chat/variables';

import { Conversation } from '@/types/chat';
import { Prompt } from '@/types/prompt';

import { PromptList } from '../Chat/ChatInput/PromptList';
import { VariableModal } from '../Chat/ChatInput/VariableModal';

interface Props {
  prompts: Prompt[];
  systemPrompt?: string;
  user?: Session['user'];
  onChangePrompt: (prompt: string) => void;
}

export const SystemPrompt: FC<Props> = ({
  prompts,
  systemPrompt = '',
  user,
  onChangePrompt,
}) => {
  const t = useTranslations();

  const [value, setValue] = useState<string>(systemPrompt);
  // The prompt whose variables are being filled in, if any.
  const [modalPrompt, setModalPrompt] = useState<Prompt | null>(null);
  const [textareaScrollHeight, setTextareaScrollHeight] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Puts `text` where "/" and its search were, and saves the result. */
  const insertPrompt = (text: string) => {
    const updated = replacePromptTrigger(value, text);
    setValue(updated);
    onChangePrompt(updated);
    textareaRef.current?.focus();
  };

  // The same "/" list as the message box (usePromptSelection).
  const {
    setShowPromptList,
    isPromptListVisible,
    activePromptIndex,
    setActivePromptIndex,
    filteredPrompts,
    promptListRef,
    handleKeyDownPromptList,
    selectPromptAt,
    updatePromptListVisibilityCallback,
  } = usePromptSelection({
    prompts,
    onPromptSelect: (prompt, _variables, hasVariables) => {
      if (hasVariables) setModalPrompt(prompt);
      else insertPrompt(prompt.content);
    },
  });

  const maxLength = Number(process.env.systemPromptmaxLength) || 500;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Hard cap is enforced by the textarea's maxLength attribute, so we
    // don't need a runtime alert. The character counter below the field
    // tells the user how close they are to the limit.
    const value = e.target.value;
    setValue(value);
    updatePromptListVisibilityCallback(value);
    // Always propagate, including the empty string. Skipping value.length === 0
    // here would mean the reducer never sees the cleared field, and the change
    // would silently revert on the next mount.
    onChangePrompt(value);
  };

  const handleClear = () => {
    setValue('');
    onChangePrompt('');
    updatePromptListVisibilityCallback('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isPromptListVisible) handleKeyDownPromptList(e);
  };

  useEffect(() => {
    if (textareaRef && textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current?.scrollHeight}px`;
      setTextareaScrollHeight(textareaRef.current.scrollHeight);
    }
  }, [value]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        promptListRef.current &&
        !promptListRef.current.contains(e.target as Node)
      ) {
        setShowPromptList(false);
      }
    };

    window.addEventListener('click', handleOutsideClick);

    return () => {
      window.removeEventListener('click', handleOutsideClick);
    };
  }, [promptListRef, setShowPromptList]);

  const valueLength = value?.length ?? 0;

  return (
    <div className="flex flex-col">
      <span className="mb-2 text-xs text-gray-600 dark:text-gray-400">
        {t(
          'Add your personal instructions to customize how the AI responds_ These are combined with core behavior guidelines that ensure helpful, accurate, and safe responses_',
        )}
      </span>
      <span className="mb-4 text-xs text-gray-500 dark:text-gray-500">
        {t('Tip: Type "/" to select from saved prompt templates_')}
      </span>
      <div className="relative">
        <textarea
          ref={textareaRef}
          className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-3 pe-12 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100"
          style={{
            resize: 'none',
            maxHeight: '300px',
            overflow: textareaScrollHeight > 300 ? 'auto' : 'hidden',
          }}
          placeholder={
            t('Enter a prompt or type "/" to select a prompt_ellipsis') || ''
          }
          value={value ?? ''}
          rows={1}
          maxLength={maxLength}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {valueLength > 0 && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={t('settings.clearField')}
            title={t('settings.clearField')}
            className="absolute end-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-400 dark:hover:text-gray-100"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mt-1 text-end text-xs text-gray-500 dark:text-gray-400 tabular-nums">
        {t('settings.characterCount', {
          current: valueLength,
          max: maxLength,
        })}
      </div>

      {isPromptListVisible && (
        <div>
          <PromptList
            id="system-prompt-list"
            activePromptIndex={activePromptIndex}
            prompts={filteredPrompts}
            onSelect={selectPromptAt}
            onMouseOver={setActivePromptIndex}
            promptListRef={promptListRef}
          />
        </div>
      )}

      {modalPrompt && (
        <VariableModal
          prompt={modalPrompt}
          onSubmit={(_values, variableMap) =>
            insertPrompt(
              replaceVariablesWithMap(modalPrompt.content, variableMap),
            )
          }
          onClose={() => setModalPrompt(null)}
        />
      )}
    </div>
  );
};
