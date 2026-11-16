'use client';

import { Conversation, Message, MessageType } from '@/types/chat';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useWorkflowRailStore } from '@/client/stores/workflowRailStore';
import { v4 as uuidv4 } from 'uuid';

/**
 * How long a rail instruction waits for the workspace to pick it up. The
 * workspace mounts with the shell (or, on a phone, as soon as its tab is
 * shown), so anything longer means it is not there at all.
 */
export const WORKSPACE_PICKUP_TIMEOUT_MS = 5_000;

/** Reply when no workspace is there to carry the instruction out. */
export const WORKSPACE_UNAVAILABLE_REPLY =
  'The translation workspace is not open, so there is no translation for me to change.';

/**
 * Translation override for the rail's send path. A message typed in the
 * rail is handed to the workspace, which knows the text in view, the target
 * language and the glossaries: a change request comes back as suggested
 * edits in the workspace (never as replaced text), a question as an answer.
 * Either way the reply is appended here as the assistant's message.
 *
 * @param conversation - The translation conversation the rail belongs to.
 * @param text - What the user typed.
 */
export async function sendRailMessage(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const userMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: text,
    messageType: MessageType.TEXT,
  };
  const messagesWithUser = [...conversation.messages, userMessage];
  useConversationStore.getState().updateConversation(conversation.id, {
    messages: messagesWithUser,
  });
  const conversationWithUser: Conversation = {
    ...conversation,
    messages: messagesWithUser,
  };

  useChatStore
    .getState()
    .initializeStreamingState(conversation.id, 'chat.loading');
  const signal = useChatStore.getState().abortController?.signal;

  const railStore = useWorkflowRailStore.getState();
  const id = uuidv4();
  const reply = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      // Still parked: nothing took it, so nothing ever will.
      if (
        useWorkflowRailStore
          .getState()
          .takeWorkspaceRequest(conversation.id, id)
      ) {
        resolve(WORKSPACE_UNAVAILABLE_REPLY);
      }
    }, WORKSPACE_PICKUP_TIMEOUT_MS);
    railStore.submitWorkspaceRequest(conversation.id, {
      id,
      text,
      signal,
      settle: (workspaceReply) => {
        clearTimeout(timer);
        resolve(workspaceReply);
      },
    });
    railStore.requestWorkspace();
  });

  if (reply.trim()) {
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: reply,
      messageType: MessageType.TEXT,
    };
    await useChatStore
      .getState()
      .finalizeMessage(assistantMessage, conversationWithUser);
  }
  useChatStore.getState().clearStreamingState();
}
