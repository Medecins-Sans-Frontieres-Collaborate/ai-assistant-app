'use client';

import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface ConversationStore {
  // State
  conversations: Conversation[];
  selectedConversationId: string | null;
  folders: FolderInterface[];
  searchTerm: string;
  isLoaded: boolean;

  // Conversation actions
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  selectConversation: (id: string | null) => void;
  setIsLoaded: (isLoaded: boolean) => void;

  // Folder actions
  setFolders: (folders: FolderInterface[]) => void;
  addFolder: (folder: FolderInterface) => void;
  updateFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;

  // Search
  setSearchTerm: (term: string) => void;

  // Bulk operations
  clearAll: () => void;
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    (set, get) => ({
      // Initial state
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: false,

      // Conversation actions
      setConversations: (conversations) => set({ conversations }),

      addConversation: (conversation) => {
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          selectedConversationId: conversation.id,
        }));
      },

      updateConversation: (id, updates) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id
              ? { ...c, ...updates, updatedAt: new Date().toISOString() }
              : c,
          ),
        })),

      deleteConversation: (id) =>
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          selectedConversationId:
            state.selectedConversationId === id
              ? null
              : state.selectedConversationId,
        })),

      selectConversation: (id) => set({ selectedConversationId: id }),

      setIsLoaded: (isLoaded) => set({ isLoaded }),

      // Folder actions
      setFolders: (folders) => set({ folders }),

      addFolder: (folder) =>
        set((state) => ({
          folders: [...state.folders, folder],
        })),

      updateFolder: (id, name) =>
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
        })),

      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          // Remove folder from conversations
          conversations: state.conversations.map((c) =>
            c.folderId === id ? { ...c, folderId: null } : c,
          ),
        })),

      // Search
      setSearchTerm: (term) => set({ searchTerm: term }),

      // Bulk operations
      clearAll: () =>
        set({
          conversations: [],
          selectedConversationId: null,
          folders: [],
          searchTerm: '',
        }),
    }),
    {
      name: 'conversation-storage',
      version: 1, // Increment this when schema changes to trigger migrations
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        selectedConversationId: state.selectedConversationId,
        folders: state.folders,
      }),
      onRehydrateStorage: () => (state) => {
        // Mark as loaded after hydration
        if (state) {
          state.isLoaded = true;
        }
      },
    },
  ),
);
