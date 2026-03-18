import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  findPromptMatch,
  updatePromptListVisibility,
} from '@/lib/utils/shared/chat/promptMatching';
import { parseVariables } from '@/lib/utils/shared/chat/variables';

import { Prompt } from '@/types/prompt';
import { SlashMenuItem, SlashMenuItemType } from '@/types/slashMenu';
import { Tone } from '@/types/tone';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface UseSlashMenuSelectionReturn {
  // State
  showSlashMenu: boolean;
  activeItemIndex: number;
  searchInputValue: string;
  filteredItems: SlashMenuItem[];
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

/** Get the display name for a slash menu item */
const getItemName = (item: SlashMenuItem): string =>
  item.type === SlashMenuItemType.PROMPT ? item.prompt.name : item.tone.name;

/** Get the ID for a slash menu item */
const getItemId = (item: SlashMenuItem): string =>
  item.type === SlashMenuItemType.PROMPT ? item.prompt.id : item.tone.id;

/**
 * Hook to manage slash menu selection (prompts + tones) with keyboard navigation.
 * Items are intermixed in a single list, sorted by usage frequency then alphabetically.
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

  const usageCounts = useSettingsStore((state) => state.slashMenuUsageCounts);
  const incrementSlashMenuUsage = useSettingsStore(
    (state) => state.incrementSlashMenuUsage,
  );

  // Build unified filtered + sorted item list
  const filteredItems: SlashMenuItem[] = useMemo(() => {
    const searchLower = searchInputValue.toLowerCase();

    const items: SlashMenuItem[] = [
      ...prompts
        .filter((p) => p.name.toLowerCase().includes(searchLower))
        .map(
          (prompt): SlashMenuItem => ({
            type: SlashMenuItemType.PROMPT,
            prompt,
          }),
        ),
      ...tones
        .filter((t) => t.name.toLowerCase().includes(searchLower))
        .map(
          (tone): SlashMenuItem => ({
            type: SlashMenuItemType.TONE,
            tone,
          }),
        ),
    ];

    // Sort: usage count desc, then alphabetical asc
    items.sort((a, b) => {
      const aCount = usageCounts[getItemId(a)] ?? 0;
      const bCount = usageCounts[getItemId(b)] ?? 0;
      if (aCount !== bCount) return bCount - aCount;
      return getItemName(a).localeCompare(getItemName(b));
    });

    return items;
  }, [prompts, tones, searchInputValue, usageCounts]);

  const totalSelectableCount = filteredItems.length;

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
   * Select the active item based on current index
   */
  const handleItemSelect = useCallback(() => {
    const item = filteredItems[activeItemIndex];
    if (!item) {
      setShowSlashMenu(false);
      return;
    }

    // Track usage
    incrementSlashMenuUsage(getItemId(item));

    if (item.type === SlashMenuItemType.PROMPT) {
      handlePromptSelectInternal(item.prompt);
    } else {
      handleToneSelectInternal(item.tone);
    }
    setShowSlashMenu(false);
  }, [
    filteredItems,
    activeItemIndex,
    handlePromptSelectInternal,
    handleToneSelectInternal,
    incrementSlashMenuUsage,
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
    filteredItems,
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
