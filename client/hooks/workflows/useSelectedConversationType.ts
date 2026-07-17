import { ConversationWorkflowType } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * Returns the workflow type of the currently selected conversation, or
 * undefined for normal chats. A primitive selector so the page-level branch
 * between <Chat> and <WorkflowShell> only re-renders on actual type changes.
 */
export function useSelectedConversationType():
  | ConversationWorkflowType
  | undefined {
  return useConversationStore(
    (state) =>
      state.conversations.find((c) => c.id === state.selectedConversationId)
        ?.conversationType,
  );
}
