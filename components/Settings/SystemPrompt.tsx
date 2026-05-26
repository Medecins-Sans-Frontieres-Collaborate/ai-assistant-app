import { IconX } from '@tabler/icons-react';
import {
  FC,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';

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
  const [activePromptIndex, setActivePromptIndex] = useState(0);
  const [showPromptList, setShowPromptList] = useState(false);
  const [promptInputValue, setPromptInputValue] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [textareaScrollHeight, setTextareaScrollHeight] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptListRef = useRef<HTMLUListElement | null>(null);

  const filteredPrompts = prompts.filter((prompt) =>
    prompt.name.toLowerCase().includes(promptInputValue.toLowerCase()),
  );

  const maxLength = Number(process.env.systemPromptmaxLength) || 500;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Hard cap is enforced by the textarea's maxLength attribute, so we
    // don't need a runtime alert. The character counter below the field
    // tells the user how close they are to the limit.
    const value = e.target.value;
    setValue(value);
    updatePromptListVisibility(value);
    // Always propagate, including the empty string. Skipping value.length === 0
    // here would mean the reducer never sees the cleared field, and the change
    // would silently revert on the next mount.
    onChangePrompt(value);
  };

  const handleClear = () => {
    setValue('');
    onChangePrompt('');
    updatePromptListVisibility('');
    textareaRef.current?.focus();
  };

  const handleInitModal = () => {
    const selectedPrompt = filteredPrompts[activePromptIndex];
    setValue((prevVal) => {
      const newContent = prevVal?.replace(/\/\w*$/, selectedPrompt.content);
      return newContent;
    });
    handlePromptSelect(selectedPrompt);
    setShowPromptList(false);
  };

  const parseVariables = (content: string) => {
    const regex = /{{(.*?)}}/g;
    const foundVariables = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      foundVariables.push(match[1]);
    }

    return foundVariables;
  };

  const updatePromptListVisibility = useCallback((text: string) => {
    const match = text.match(/\/\w*$/);

    if (match) {
      setShowPromptList(true);
      setPromptInputValue(match[0].slice(1));
    } else {
      setShowPromptList(false);
      setPromptInputValue('');
    }
  }, []);

  const handlePromptSelect = (prompt: Prompt) => {
    const parsedVariables = parseVariables(prompt.content);
    setVariables(parsedVariables);

    if (parsedVariables.length > 0) {
      setIsModalVisible(true);
    } else {
      const updatedContent = value?.replace(/\/\w*$/, prompt.content);

      setValue(updatedContent);
      onChangePrompt(updatedContent);

      updatePromptListVisibility(prompt.content);
    }
  };

  const handleSubmit = (updatedVariables: string[]) => {
    const newContent = value?.replace(/{{(.*?)}}/g, (match, variable) => {
      const index = variables.indexOf(variable);
      return updatedVariables[index];
    });

    setValue(newContent);
    onChangePrompt(newContent);

    if (textareaRef && textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPromptList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActivePromptIndex((prevIndex) =>
          prevIndex < prompts.length - 1 ? prevIndex + 1 : prevIndex,
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActivePromptIndex((prevIndex) =>
          prevIndex > 0 ? prevIndex - 1 : prevIndex,
        );
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setActivePromptIndex((prevIndex) =>
          prevIndex < prompts.length - 1 ? prevIndex + 1 : 0,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleInitModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowPromptList(false);
      } else {
        setActivePromptIndex(0);
      }
    }
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
  }, []);

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
          className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-3 pr-12 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100"
          style={{
            resize: 'none',
            maxHeight: '300px',
            overflow: textareaScrollHeight > 300 ? 'auto' : 'hidden',
          }}
          placeholder={
            t(`Enter a prompt or type "/" to select a prompt...`) || ''
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
            className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-400 dark:hover:text-gray-100"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mt-1 text-right text-xs text-gray-500 dark:text-gray-400 tabular-nums">
        {t('settings.characterCount', {
          current: valueLength,
          max: maxLength,
        })}
      </div>

      {showPromptList && filteredPrompts.length > 0 && (
        <div>
          <PromptList
            activePromptIndex={activePromptIndex}
            prompts={filteredPrompts}
            onSelect={handleInitModal}
            onMouseOver={setActivePromptIndex}
            promptListRef={promptListRef}
          />
        </div>
      )}

      {isModalVisible && (
        <VariableModal
          prompt={prompts[activePromptIndex]}
          variables={variables}
          onSubmit={handleSubmit}
          onClose={() => setIsModalVisible(false)}
        />
      )}
    </div>
  );
};
