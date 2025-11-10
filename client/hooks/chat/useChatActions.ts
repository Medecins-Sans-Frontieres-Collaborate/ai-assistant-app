import { useCallback } from 'react';

import { Message, MessageType } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { useConversationStore } from '@/client/stores/conversationStore';

interface UseChatActionsProps {
  updateConversation: (id: string, updates: any) => void;
  sendMessage?: (
    message: Message,
    conversation: any,
    searchMode?: SearchMode,
  ) => void;
}

/**
 * Custom hook to handle all chat message and conversation actions
 * Manages sending, editing, clearing, and regenerating messages
 */
export function useChatActions({
  updateConversation,
  sendMessage,
}: UseChatActionsProps) {
  const handleClearAll = useCallback(() => {
    const state = useConversationStore.getState();
    const currentConversation = state.conversations.find(
      (c) => c.id === state.selectedConversationId,
    );

    if (
      currentConversation &&
      window.confirm('Are you sure you want to clear this conversation?')
    ) {
      updateConversation(currentConversation.id, {
        messages: [],
      });
    }
  }, [updateConversation]);

  const handleEditMessage = useCallback(
    (editedMessage: Message) => {
      const state = useConversationStore.getState();
      const currentConversation = state.conversations.find(
        (c) => c.id === state.selectedConversationId,
      );

      if (!currentConversation) return;

      // Find the message to edit by matching properties (excluding content)
      // The editedMessage is a copy of the original with changed content
      const messageIndex = currentConversation.messages.findIndex(
        (msg) =>
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
          msg.promptId === editedMessage.promptId,
      );

      if (messageIndex === -1) return;

      const updatedMessages = currentConversation.messages.map((msg, idx) =>
        idx === messageIndex ? editedMessage : msg,
      );

      updateConversation(currentConversation.id, {
        messages: updatedMessages,
      });
    },
    [updateConversation],
  );

  const handleSend = useCallback(
    (message: Message, searchMode?: SearchMode) => {
      const state = useConversationStore.getState();
      const currentConversation = state.conversations.find(
        (c) => c.id === state.selectedConversationId,
      );

      if (!currentConversation) return;

      const updatedMessages = [...currentConversation.messages, message];

      updateConversation(currentConversation.id, { messages: updatedMessages });

      const updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
      };
      sendMessage?.(message, updatedConversation, searchMode);
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

  const handleRegenerate = useCallback(() => {
    const state = useConversationStore.getState();
    const currentConversation = state.conversations.find(
      (c) => c.id === state.selectedConversationId,
    );

    if (!currentConversation || currentConversation.messages.length === 0)
      return;

    const lastUserMessageIndex = currentConversation.messages.findLastIndex(
      (m) => m.role === 'user',
    );
    if (lastUserMessageIndex === -1) return;

    const messagesUpToLastUser = currentConversation.messages.slice(
      0,
      lastUserMessageIndex + 1,
    );
    updateConversation(currentConversation.id, {
      messages: messagesUpToLastUser,
    });

    const lastUserMessage = currentConversation.messages[lastUserMessageIndex];
    const updatedConversation = {
      ...currentConversation,
      messages: messagesUpToLastUser,
    };
    sendMessage?.(lastUserMessage, updatedConversation, undefined);
  }, [updateConversation, sendMessage]);

  return {
    handleClearAll,
    handleEditMessage,
    handleSend,
    handleSelectPrompt,
    handleRegenerate,
  };
}
