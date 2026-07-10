'use client';

import { Message, MessageType } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';
import { v4 as uuidv4 } from 'uuid';

/**
 * Appends a user/assistant exchange to a workflow conversation so the run
 * shows up in the conversation rail (and in sidebar previews, export,
 * search) as ordinary messages.
 */
export function appendWorkflowRailMessages(
  conversationId: string,
  userText: string,
  assistantText: string,
): void {
  const store = useConversationStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  if (!conversation) return;

  const userMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: userText,
    messageType: MessageType.TEXT,
  };
  const assistantMessage: Message = {
    id: uuidv4(),
    role: 'assistant',
    content: assistantText,
    messageType: MessageType.TEXT,
  };
  store.updateConversation(conversationId, {
    messages: [...conversation.messages, userMessage, assistantMessage],
  });
}
