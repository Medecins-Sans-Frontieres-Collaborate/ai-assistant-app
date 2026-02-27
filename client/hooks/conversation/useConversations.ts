import { useShallow } from 'zustand/react/shallow';

import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * Hook that manages conversations
 * Persistence is handled automatically by Zustand persist middleware
 */
export function useConversations() {
  // FIXED: useShallow prevents re-render when array content is same but reference differs
  const conversations = useConversationStore(
    useShallow((state) => state.conversations),
  );
  const selectedConversationId = useConversationStore(
    (state) => state.selectedConversationId,
  );
  // FIXED: useShallow for arrays
  const folders = useConversationStore(useShallow((state) => state.folders));
  const searchTerm = useConversationStore((state) => state.searchTerm);
  const isLoaded = useConversationStore((state) => state.isLoaded);

  // Get actions
  const addConversation = useConversationStore(
    (state) => state.addConversation,
  );
  const updateConversation = useConversationStore(
    (state) => state.updateConversation,
  );
  const deleteConversation = useConversationStore(
    (state) => state.deleteConversation,
  );
  const selectConversation = useConversationStore(
    (state) => state.selectConversation,
  );
  const setConversations = useConversationStore(
    (state) => state.setConversations,
  );
  const setIsLoaded = useConversationStore((state) => state.setIsLoaded);
  const addFolder = useConversationStore((state) => state.addFolder);
  const updateFolder = useConversationStore((state) => state.updateFolder);
  const deleteFolder = useConversationStore((state) => state.deleteFolder);
  const setFolders = useConversationStore((state) => state.setFolders);
  const setSearchTerm = useConversationStore((state) => state.setSearchTerm);
  const clearAll = useConversationStore((state) => state.clearAll);

  // Compute selected conversation from state
  const selectedConversation =
    conversations.find((c) => c.id === selectedConversationId) || null;

  // Compute filtered conversations
  const filteredConversations = !searchTerm
    ? conversations
    : conversations.filter((c) => {
        const searchLower = searchTerm.toLowerCase();
        if (c.name?.toLowerCase().includes(searchLower)) return true;

        // Search in message content
        return c.messages.some((entry) => {
          // For assistant message groups, search in active version's content
          if ('type' in entry && entry.type === 'assistant_group') {
            const activeVersion = entry.versions[entry.activeIndex];
            return activeVersion.content
              .toString()
              .toLowerCase()
              .includes(searchLower);
          }
          // For legacy messages (type guard)
          if ('content' in entry) {
            return entry.content.toString().toLowerCase().includes(searchLower);
          }
          return false;
        });
      });

  return {
    // State
    conversations,
    selectedConversation,
    folders,
    searchTerm,
    filteredConversations,
    isLoaded,

    // Actions
    addConversation,
    updateConversation,
    deleteConversation,
    selectConversation,
    setConversations,

    // Folder actions
    addFolder,
    updateFolder,
    deleteFolder,
    setFolders,

    // Search
    setSearchTerm,

    // Bulk
    clearAll,
  };
}
