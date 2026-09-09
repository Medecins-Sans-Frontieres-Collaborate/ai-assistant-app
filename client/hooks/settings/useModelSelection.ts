import { useCallback } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

/**
 * Custom hook to handle model selection logic
 * Manages model updates and search mode configuration
 */
export function useModelSelection() {
  const { selectedConversation, updateConversation } = useConversations();

  const handleModelSelect = useCallback(
    (model: OpenAIModel) => {
      if (!selectedConversation) {
        return;
      }

      // Build update object
      // Update conversation with selected model
      // Initialize defaultSearchMode to INTELLIGENT (privacy-focused) if not already set
      const updates: Partial<Conversation> = {
        model: model,
      };

      // Leaving a LEGACY agent selection (bot mirroring an `org-` model id)
      // must clear the mirror — left behind it would read as an explicit
      // attachment and hijack the newly chosen model. A decoupled
      // attachment (bot beside a real model) survives model switches.
      if (
        selectedConversation.bot &&
        selectedConversation.model?.id === `org-${selectedConversation.bot}`
      ) {
        updates.bot = undefined;
      }

      // If the conversation has never had a search mode set before, set it to INTELLIGENT
      if (
        selectedConversation.defaultSearchMode === undefined ||
        selectedConversation.defaultSearchMode === null
      ) {
        updates.defaultSearchMode = SearchMode.INTELLIGENT;
      }

      updateConversation(selectedConversation.id, updates);
    },
    [selectedConversation, updateConversation],
  );

  const handleToggleSearchMode = useCallback(() => {
    if (!selectedConversation) {
      return;
    }

    const currentMode =
      selectedConversation.defaultSearchMode ?? SearchMode.OFF;
    const newMode =
      currentMode === SearchMode.OFF ? SearchMode.INTELLIGENT : SearchMode.OFF;

    updateConversation(selectedConversation.id, {
      defaultSearchMode: newMode,
    });
  }, [selectedConversation, updateConversation]);

  const handleSetSearchMode = useCallback(
    (mode: SearchMode) => {
      if (!selectedConversation) {
        return;
      }

      updateConversation(selectedConversation.id, {
        defaultSearchMode: mode,
      });
    },
    [selectedConversation, updateConversation],
  );

  return {
    handleModelSelect,
    handleToggleSearchMode,
    handleSetSearchMode,
  };
}
