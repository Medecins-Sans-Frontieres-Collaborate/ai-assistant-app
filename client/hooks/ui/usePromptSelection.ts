import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import {
  findPromptMatch,
  updatePromptListVisibility,
} from '@/lib/utils/chat/promptMatching';
import { parseVariables } from '@/lib/utils/chat/variables';

import { Prompt } from '@/types/prompt';

export interface UsePromptSelectionReturn {
  // State
  showPromptList: boolean;
  activePromptIndex: number;
  promptInputValue: string;
  filteredPrompts: Prompt[];
  promptListRef: React.MutableRefObject<HTMLUListElement | null>;

  // Setters
  setShowPromptList: (show: boolean) => void;
  setActivePromptIndex: (index: number | ((prev: number) => number)) => void;
  setPromptInputValue: (value: string) => void;

  // Actions
  handlePromptSelect: (prompt: Prompt) => void;
  handleKeyDownPromptList: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleInitModal: () => void;
  updatePromptListVisibilityCallback: (text: string) => void;
  findAndSelectMatchingPrompt: (textValue: string, prompts: Prompt[]) => void;
}

export interface UsePromptSelectionOptions {
  prompts: Prompt[];
  onPromptSelect?: (
    prompt: Prompt,
    variables: string[],
    hasVariables: boolean,
  ) => void;
  onResetInputState?: () => void;
}

/**
 * Hook to manage prompt selection with keyboard navigation
 */
export function usePromptSelection({
  prompts,
  onPromptSelect,
  onResetInputState,
}: UsePromptSelectionOptions): UsePromptSelectionReturn {
  const [showPromptList, setShowPromptList] = useState<boolean>(false);
  const [activePromptIndex, setActivePromptIndex] = useState<number>(0);
  const [promptInputValue, setPromptInputValue] = useState<string>('');
  const promptListRef = useRef<HTMLUListElement | null>(null);

  // Filter prompts based on input
  const filteredPrompts: Prompt[] = prompts.filter((prompt) =>
    prompt.name.toLowerCase().includes(promptInputValue.toLowerCase()),
  );

  /**
   * Handle selecting a prompt
   */
  const handlePromptSelect = useCallback(
    (prompt: Prompt) => {
      const parsedVariables = parseVariables(prompt.content);

      if (onPromptSelect) {
        onPromptSelect(prompt, parsedVariables, parsedVariables.length > 0);
      }
    },
    [onPromptSelect],
  );

  /**
   * Initialize modal with selected prompt
   */
  const handleInitModal = useCallback(() => {
    const selectedPrompt = filteredPrompts[activePromptIndex];
    if (selectedPrompt) {
      handlePromptSelect(selectedPrompt);
    }
    setShowPromptList(false);
  }, [filteredPrompts, activePromptIndex, handlePromptSelect]);

  /**
   * Handle keyboard navigation in prompt list
   */
  const handleKeyDownPromptList = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActivePromptIndex((prevIndex) =>
            prevIndex < filteredPrompts.length - 1 ? prevIndex + 1 : prevIndex,
          );
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActivePromptIndex((prevIndex) =>
            prevIndex > 0 ? prevIndex - 1 : prevIndex,
          );
          break;
        case 'Tab':
          event.preventDefault();
          setActivePromptIndex((prevIndex) =>
            prevIndex < filteredPrompts.length - 1 ? prevIndex + 1 : 0,
          );
          break;
        case 'Enter':
          event.preventDefault();
          handleInitModal();
          if (onResetInputState) {
            onResetInputState();
          }
          break;
        case 'Escape':
          event.preventDefault();
          setShowPromptList(false);
          break;
        default:
          setActivePromptIndex(0);
          break;
      }
    },
    [filteredPrompts.length, handleInitModal, onResetInputState],
  );

  /**
   * Update prompt list visibility based on text input
   */
  const updatePromptListVisibilityCallback = useCallback((text: string) => {
    const result = updatePromptListVisibility(text);
    setShowPromptList(result.showList);
    setPromptInputValue(result.inputValue);
  }, []);

  /**
   * Find and auto-select matching prompt based on text
   */
  const findAndSelectMatchingPrompt = useCallback(
    (textValue: string, availablePrompts: Prompt[]) => {
      const matchResult = findPromptMatch(textValue);
      if (matchResult.matched) {
        const matchingPrompt = availablePrompts.find(
          (prompt) =>
            prompt.name.toLowerCase() === matchResult.searchTerm.toLowerCase(),
        );
        if (matchingPrompt) {
          handlePromptSelect(matchingPrompt);
        }
      }
    },
    [handlePromptSelect],
  );

  // Sync scroll position with active prompt index
  useEffect(() => {
    if (promptListRef.current) {
      promptListRef.current.scrollTop = activePromptIndex * 30;
    }
  }, [activePromptIndex]);

  return {
    // State
    showPromptList,
    activePromptIndex,
    promptInputValue,
    filteredPrompts,
    promptListRef,

    // Setters
    setShowPromptList,
    setActivePromptIndex,
    setPromptInputValue,

    // Actions
    handlePromptSelect,
    handleKeyDownPromptList,
    handleInitModal,
    updatePromptListVisibilityCallback,
    findAndSelectMatchingPrompt,
  };
}
