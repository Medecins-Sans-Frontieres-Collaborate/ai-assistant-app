import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import {
  findPromptMatch,
  updatePromptListVisibility,
} from '@/lib/utils/shared/chat/promptMatching';
import { parseVariables } from '@/lib/utils/shared/chat/variables';

import { Prompt } from '@/types/prompt';
import { Tone } from '@/types/tone';

export interface UseSlashMenuSelectionReturn {
  // State
  showSlashMenu: boolean;
  activeItemIndex: number;
  searchInputValue: string;
  filteredPrompts: Prompt[];
  filteredTones: Tone[];
  slashMenuRef: React.MutableRefObject<HTMLUListElement | null>;

  // Setters
  setShowSlashMenu: (show: boolean) => void;
  setActiveItemIndex: (index: number | ((prev: number) => number)) => void;
  setSearchInputValue: (value: string) => void;

  // Actions
  handleItemSelect: () => void;
  handleKeyDownSlashMenu: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  updateSlashMenuVisibility: (text: string) => void;
  findAndSelectMatchingItem: (
    textValue: string,
    prompts: Prompt[],
    tones: Tone[],
  ) => void;
}

export interface UseSlashMenuSelectionOptions {
  prompts: Prompt[];
  tones: Tone[];
  onPromptSelect?: (
    prompt: Prompt,
    variables: string[],
    hasVariables: boolean,
  ) => void;
  onToneSelect?: (tone: Tone) => void;
  onResetInputState?: () => void;
}

/**
 * Hook to manage slash menu selection (prompts + tones) with keyboard navigation
 */
export function useSlashMenuSelection({
  prompts,
  tones,
  onPromptSelect,
  onToneSelect,
  onResetInputState,
}: UseSlashMenuSelectionOptions): UseSlashMenuSelectionReturn {
  const [showSlashMenu, setShowSlashMenu] = useState<boolean>(false);
  const [activeItemIndex, setActiveItemIndex] = useState<number>(0);
  const [searchInputValue, setSearchInputValue] = useState<string>('');
  const slashMenuRef = useRef<HTMLUListElement | null>(null);

  // Filter prompts and tones based on input
  const filteredPrompts: Prompt[] = prompts.filter((prompt) =>
    prompt.name.toLowerCase().includes(searchInputValue.toLowerCase()),
  );

  const filteredTones: Tone[] = tones.filter((tone) =>
    tone.name.toLowerCase().includes(searchInputValue.toLowerCase()),
  );

  const totalSelectableCount = filteredPrompts.length + filteredTones.length;

  /**
   * Handle selecting a prompt
   */
  const handlePromptSelectInternal = useCallback(
    (prompt: Prompt) => {
      const parsedVariables = parseVariables(prompt.content);

      if (onPromptSelect) {
        onPromptSelect(prompt, parsedVariables, parsedVariables.length > 0);
      }
    },
    [onPromptSelect],
  );

  /**
   * Handle selecting a tone
   */
  const handleToneSelectInternal = useCallback(
    (tone: Tone) => {
      if (onToneSelect) {
        onToneSelect(tone);
      }
    },
    [onToneSelect],
  );

  /**
   * Select the active item (prompt or tone) based on current index
   */
  const handleItemSelect = useCallback(() => {
    if (activeItemIndex < filteredPrompts.length) {
      // Index falls within prompts range
      const selectedPrompt = filteredPrompts[activeItemIndex];
      if (selectedPrompt) {
        handlePromptSelectInternal(selectedPrompt);
      }
    } else {
      // Index falls within tones range
      const toneIndex = activeItemIndex - filteredPrompts.length;
      const selectedTone = filteredTones[toneIndex];
      if (selectedTone) {
        handleToneSelectInternal(selectedTone);
      }
    }
    setShowSlashMenu(false);
  }, [
    filteredPrompts,
    filteredTones,
    activeItemIndex,
    handlePromptSelectInternal,
    handleToneSelectInternal,
  ]);

  /**
   * Handle keyboard navigation in slash menu
   */
  const handleKeyDownSlashMenu = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveItemIndex((prevIndex) =>
            prevIndex < totalSelectableCount - 1 ? prevIndex + 1 : prevIndex,
          );
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveItemIndex((prevIndex) =>
            prevIndex > 0 ? prevIndex - 1 : prevIndex,
          );
          break;
        case 'Tab':
          event.preventDefault();
          setActiveItemIndex((prevIndex) =>
            prevIndex < totalSelectableCount - 1 ? prevIndex + 1 : 0,
          );
          break;
        case 'Enter':
          event.preventDefault();
          handleItemSelect();
          if (onResetInputState) {
            onResetInputState();
          }
          break;
        case 'Escape':
          event.preventDefault();
          setShowSlashMenu(false);
          break;
        default:
          setActiveItemIndex(0);
          break;
      }
    },
    [totalSelectableCount, handleItemSelect, onResetInputState],
  );

  /**
   * Update slash menu visibility based on text input
   */
  const updateSlashMenuVisibility = useCallback((text: string) => {
    const result = updatePromptListVisibility(text);
    setShowSlashMenu(result.showList);
    setSearchInputValue(result.inputValue);
  }, []);

  /**
   * Find and auto-select matching item based on text
   */
  const findAndSelectMatchingItem = useCallback(
    (textValue: string, availablePrompts: Prompt[], availableTones: Tone[]) => {
      const matchResult = findPromptMatch(textValue);
      if (matchResult.matched) {
        const matchingPrompt = availablePrompts.find(
          (prompt) =>
            prompt.name.toLowerCase() === matchResult.searchTerm.toLowerCase(),
        );
        if (matchingPrompt) {
          handlePromptSelectInternal(matchingPrompt);
          return;
        }

        const matchingTone = availableTones.find(
          (tone) =>
            tone.name.toLowerCase() === matchResult.searchTerm.toLowerCase(),
        );
        if (matchingTone) {
          handleToneSelectInternal(matchingTone);
        }
      }
    },
    [handlePromptSelectInternal, handleToneSelectInternal],
  );

  // Sync scroll position with active item index
  useEffect(() => {
    if (slashMenuRef.current) {
      slashMenuRef.current.scrollTop = activeItemIndex * 30;
    }
  }, [activeItemIndex]);

  return {
    // State
    showSlashMenu,
    activeItemIndex,
    searchInputValue,
    filteredPrompts,
    filteredTones,
    slashMenuRef,

    // Setters
    setShowSlashMenu,
    setActiveItemIndex,
    setSearchInputValue,

    // Actions
    handleItemSelect,
    handleKeyDownSlashMenu,
    updateSlashMenuVisibility,
    findAndSelectMatchingItem,
  };
}
