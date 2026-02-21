import { useCallback } from 'react';

import { createDefaultConversation } from '@/lib/utils/app/conversationInit';
import {
  entryToDisplayMessage,
  findPrecedingUserMessageIndex,
  flattenEntriesForAPI,
} from '@/lib/utils/shared/chat/messageVersioning';

import {
  Message,
  MessageType,
  isAssistantMessageGroup,
  isLegacyMessage,
} from '@/types/chat';
import { CodeInterpreterMode } from '@/types/codeInterpreter';
import { SearchMode } from '@/types/searchMode';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

interface UseChatActionsProps {
  updateConversation: (id: string, updates: any) => void;
  sendMessage?: (
    message: Message,
    conversation: any,
    searchMode?: SearchMode,
    codeInterpreterMode?: CodeInterpreterMode,
  ) => void;
}

/**
 * Custom hook to handle chat message actions.
 * Manages sending, editing, and regenerating messages.
 *
 * @param props.updateConversation - Function to update conversation data
 * @param props.sendMessage - Optional function to send messages to the chat service
 * @returns Object containing message action handlers
 */
export function useChatActions({
  updateConversation,
  sendMessage,
}: UseChatActionsProps) {
  const handleEditMessage = useCallback(
    (editedMessage: Message) => {
      const state = useConversationStore.getState();
      const currentConversation = state.conversations.find(
        (c) => c.id === state.selectedConversationId,
      );

      if (!currentConversation) return;

      // Find the message to edit by matching properties (excluding content)
      // The editedMessage is a copy of the original with changed content
      // Only user messages can be edited, and they are always legacy Messages
      const messageIndex = currentConversation.messages.findIndex((entry) => {
        if (!isLegacyMessage(entry)) return false;
        const msg = entry;
        return (
          msg.role === editedMessage.role &&
          msg.messageType === editedMessage.messageType &&
          // Match citations if present
          JSON.stringify(msg.citations) ===
            JSON.stringify(editedMessage.citations) &&
          // Match thinking if present
          msg.thinking === editedMessage.thinking &&
          // Match other metadata
          msg.error === editedMessage.error &&
          msg.toneId === editedMessage.toneId &&
          msg.promptId === editedMessage.promptId
        );
      });

      if (messageIndex === -1) return;

      const updatedMessages = currentConversation.messages.map((entry, idx) =>
        idx === messageIndex ? editedMessage : entry,
      );

      updateConversation(currentConversation.id, {
        messages: updatedMessages,
      });
    },
    [updateConversation],
  );

  const handleSend = useCallback(
    (
      message: Message,
      searchMode?: SearchMode,
      codeInterpreterMode?: CodeInterpreterMode,
    ) => {
      const conversationState = useConversationStore.getState();
      const settingsState = useSettingsStore.getState();

      let currentConversation = conversationState.conversations.find(
        (c) => c.id === conversationState.selectedConversationId,
      );

      // If no conversation exists, create one first
      if (!currentConversation) {
        const {
          models,
          defaultModelId,
          systemPrompt,
          temperature,
          defaultSearchMode,
        } = settingsState;

        if (models.length === 0) {
          console.error('Cannot create conversation: no models available');
          return;
        }

        // Create a new conversation with the user's message
        const newConversation = createDefaultConversation(
          models,
          defaultModelId,
          systemPrompt || '',
          temperature || 0.5,
          defaultSearchMode,
        );

        const conversationWithMessage = {
          ...newConversation,
          messages: [message],
        };

        // Add and select the new conversation
        conversationState.addConversation(conversationWithMessage);

        // Send the message with the new conversation
        sendMessage?.(
          message,
          conversationWithMessage,
          searchMode,
          codeInterpreterMode,
        );
        return;
      }

      // Existing conversation flow
      const updatedMessages = [...currentConversation.messages, message];

      updateConversation(currentConversation.id, { messages: updatedMessages });

      const updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
      };
      sendMessage?.(
        message,
        updatedConversation,
        searchMode,
        codeInterpreterMode,
      );
    },
    [updateConversation, sendMessage],
  );

  const handleSelectPrompt = useCallback(
    (prompt: string) => {
      handleSend({
        role: 'user',
        content: prompt,
        messageType: MessageType.TEXT,
      });
    },
    [handleSend],
  );

  /**
   * Regenerates an assistant response, adding a new version instead of replacing.
   * @param messageIndex - Optional index of the assistant message to regenerate.
   *                       If not provided, regenerates the last assistant message.
   */
  const handleRegenerate = useCallback(
    (messageIndex?: number) => {
      const conversationState = useConversationStore.getState();
      const chatState = useChatStore.getState();
      const currentConversation = conversationState.conversations.find(
        (c) => c.id === conversationState.selectedConversationId,
      );

      if (!currentConversation || currentConversation.messages.length === 0)
        return;

      // Determine which assistant message to regenerate
      let targetIndex: number;
      let userMessageIndex: number;

      if (messageIndex !== undefined) {
        // Regenerating a specific assistant message
        targetIndex = messageIndex;
        userMessageIndex = findPrecedingUserMessageIndex(
          currentConversation.messages,
          messageIndex,
        );
      } else {
        // Regenerating the last assistant message
        targetIndex = currentConversation.messages.length - 1;
        // Find the last user message before the assistant message
        userMessageIndex = findPrecedingUserMessageIndex(
          currentConversation.messages,
          targetIndex,
        );
      }

      if (userMessageIndex === -1) return;

      // Verify the target is an assistant message group
      const targetEntry = currentConversation.messages[targetIndex];
      if (
        !isAssistantMessageGroup(targetEntry) &&
        !(isLegacyMessage(targetEntry) && targetEntry.role === 'assistant')
      ) {
        return;
      }

      // Get the user message to resend
      const userMessageEntry = currentConversation.messages[userMessageIndex];
      const userMessage = entryToDisplayMessage(userMessageEntry);

      // Set the regenerating index in chat store
      chatState.setRegeneratingIndex(targetIndex);

      // Create a flattened conversation snapshot for the API call
      // Only include messages up to and including the user message
      const messagesForAPI = flattenEntriesForAPI(
        currentConversation.messages.slice(0, userMessageIndex + 1),
      );

      const apiConversation = {
        ...currentConversation,
        messages: messagesForAPI,
      };

      sendMessage?.(userMessage, apiConversation, undefined, undefined);
    },
    [sendMessage],
  );

  return {
    handleEditMessage,
    handleSend,
    handleSelectPrompt,
    handleRegenerate,
  };
}
