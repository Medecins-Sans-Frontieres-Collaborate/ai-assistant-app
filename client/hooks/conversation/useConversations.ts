import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useConversationStore } from '@/client/stores/conversationStore';

/** Debounce window for the search input — caps the O(N×M) filter rate. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Hook that manages conversations. Persistence is handled by Zustand's
 * `persist` middleware on the store.
 */
export function useConversations() {
  const conversations = useConversationStore((state) => state.conversations);
  const selectedConversationId = useConversationStore(
    (state) => state.selectedConversationId,
  );
  const folders = useConversationStore((state) => state.folders);
  const searchTerm = useConversationStore((state) => state.searchTerm);
  const isLoaded = useConversationStore((state) => state.isLoaded);

  // useShallow so this hook doesn't re-run when other store slices change.
  const actions = useConversationStore(
    useShallow((state) => ({
      addConversation: state.addConversation,
      updateConversation: state.updateConversation,
      deleteConversation: state.deleteConversation,
      selectConversation: state.selectConversation,
      setConversations: state.setConversations,
      setIsLoaded: state.setIsLoaded,
      addFolder: state.addFolder,
      updateFolder: state.updateFolder,
      deleteFolder: state.deleteFolder,
      setFolders: state.setFolders,
      setSearchTerm: state.setSearchTerm,
      clearAll: state.clearAll,
    })),
  );

  const selectedConversation = useMemo(() => {
    if (!selectedConversationId) return null;
    return conversations.find((c) => c.id === selectedConversationId) ?? null;
  }, [conversations, selectedConversationId]);

  // Debounced copy of searchTerm — the store keeps the raw value for the
  // input; the filter below reads this. Empty-term clear uses 0ms so the
  // setState happens after the effect body (lint-clean) but still feels
  // instant to the user.
  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm);
  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedSearch(searchTerm),
      searchTerm ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(handle);
  }, [searchTerm]);

  const filteredConversations = useMemo(() => {
    if (!debouncedSearch) return conversations;
    const searchLower = debouncedSearch.toLowerCase();
    return conversations.filter((c) => {
      if (c.name?.toLowerCase().includes(searchLower)) return true;
      return c.messages.some((entry) => {
        if ('type' in entry && entry.type === 'assistant_group') {
          const activeVersion = entry.versions[entry.activeIndex];
          return activeVersion.content
            .toString()
            .toLowerCase()
            .includes(searchLower);
        }
        if ('content' in entry) {
          return entry.content.toString().toLowerCase().includes(searchLower);
        }
        return false;
      });
    });
  }, [conversations, debouncedSearch]);

  return {
    // State
    conversations,
    selectedConversation,
    folders,
    searchTerm,
    filteredConversations,
    isLoaded,

    // Actions
    addConversation: actions.addConversation,
    updateConversation: actions.updateConversation,
    deleteConversation: actions.deleteConversation,
    selectConversation: actions.selectConversation,
    setConversations: actions.setConversations,

    // Folder actions
    addFolder: actions.addFolder,
    updateFolder: actions.updateFolder,
    deleteFolder: actions.deleteFolder,
    setFolders: actions.setFolders,

    // Search
    setSearchTerm: actions.setSearchTerm,

    // Bulk
    clearAll: actions.clearAll,
  };
}
