'use client';

import {
  migrateLegacyMessages,
  needsMigration,
} from '@/lib/utils/shared/chat/messageVersioning';

import {
  ActiveFile,
  AssistantMessageVersion,
  Conversation,
  isAssistantMessageGroup,
} from '@/types/chat';
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

  // Version navigation actions
  setActiveVersion: (
    conversationId: string,
    messageIndex: number,
    versionIndex: number,
  ) => void;
  navigateVersion: (
    conversationId: string,
    messageIndex: number,
    direction: 'prev' | 'next',
  ) => void;
  addMessageVersion: (
    conversationId: string,
    messageIndex: number,
    version: AssistantMessageVersion,
  ) => void;

  /**
   * Updates a message's content to replace a transcription placeholder with actual transcript.
   * Used for async batch transcription when the job completes after the message is sent.
   *
   * Uses jobId-based matching for reliable updates (falls back to placeholder string matching).
   *
   * @param conversationId - The conversation ID
   * @param messageIndex - The index of the assistant message with the placeholder
   * @param transcript - The actual transcript content
   * @param filename - The filename for the transcript header
   * @param jobId - Optional job ID for reliable message matching
   */
  updateMessageWithTranscript: (
    conversationId: string,
    messageIndex: number,
    transcript: string,
    filename: string,
    jobId?: string,
  ) => void;

  // Active file actions
  activateFile: (conversationId: string, file: ActiveFile) => void;
  deactivateFile: (conversationId: string, fileId: string) => void;
  updateFileProcessedContent: (
    conversationId: string,
    fileId: string,
    content: NonNullable<ActiveFile['processedContent']>,
  ) => void;
  clearAllActiveFiles: (conversationId: string) => void;
  setPinned: (conversationId: string, fileId: string, pinned: boolean) => void;
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

      // Version navigation actions
      setActiveVersion: (conversationId, messageIndex, versionIndex) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];

            if (isAssistantMessageGroup(entry)) {
              const clampedIndex = Math.max(
                0,
                Math.min(versionIndex, entry.versions.length - 1),
              );
              messages[messageIndex] = {
                ...entry,
                activeIndex: clampedIndex,
              };
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),

      navigateVersion: (conversationId, messageIndex, direction) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];

            if (isAssistantMessageGroup(entry)) {
              const newIndex =
                direction === 'prev'
                  ? entry.activeIndex - 1
                  : entry.activeIndex + 1;

              // Only update if within bounds
              if (newIndex >= 0 && newIndex < entry.versions.length) {
                messages[messageIndex] = { ...entry, activeIndex: newIndex };
              }
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),

      addMessageVersion: (conversationId, messageIndex, version) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];

            if (isAssistantMessageGroup(entry)) {
              // Add new version and set it as active
              messages[messageIndex] = {
                ...entry,
                versions: [...entry.versions, version],
                activeIndex: entry.versions.length, // Point to new version
              };
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),

      updateMessageWithTranscript: (
        conversationId,
        messageIndex,
        transcript,
        filename,
        jobId,
      ) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];

            // Handle assistant message groups (most likely case)
            if (isAssistantMessageGroup(entry)) {
              const updatedVersions = entry.versions.map((v) => {
                // Check if transcript is already formatted (e.g., from blob storage)
                // Format: "[Transcript: filename | blob:jobId | expires:...]" or "[Transcript: filename]\n..."
                const isPreformatted = transcript.startsWith('[Transcript:');
                const formattedContent = isPreformatted
                  ? transcript
                  : `[Transcript: ${filename}]\n${transcript}`;

                // Primary matching: by jobId in transcript metadata (most reliable)
                if (jobId && v.transcript?.jobId === jobId) {
                  console.log(
                    `[ConversationStore] Matched message by jobId: ${jobId}`,
                  );
                  return {
                    ...v,
                    content: formattedContent,
                    transcript: {
                      ...v.transcript,
                      transcript: transcript, // Update the stored transcript
                    },
                  };
                }

                // Fallback: Replace placeholder with actual transcript (string matching)
                const placeholder = `[Transcription in progress: ${filename}]`;
                if (
                  typeof v.content === 'string' &&
                  v.content.includes(placeholder)
                ) {
                  console.log(
                    `[ConversationStore] Matched message by placeholder text`,
                  );
                  return {
                    ...v,
                    content: v.content.replace(placeholder, formattedContent),
                  };
                }

                return v;
              });

              messages[messageIndex] = {
                ...entry,
                versions: updatedVersions,
              };
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),

      // Active file actions
      activateFile: (conversationId, file) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const existing = c.activeFiles ?? [];

            // Deduplicate by id
            const alreadyExists = existing.some((f) => f.id === file.id);
            let next = alreadyExists ? existing : [...existing, file];

            // If exceeding 5 files, remove oldest unpinned files
            const MAX_FILES = 5;
            while (next.length > MAX_FILES) {
              // Find oldest unpinned file
              const unpinned = next.filter((f) => !f.pinned);
              if (unpinned.length === 0) break; // All pinned, can't remove

              // Sort by addedAt ascending (oldest first)
              unpinned.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
              const oldestUnpinned = unpinned[0];

              // Remove it
              next = next.filter((f) => f.id !== oldestUnpinned.id);
            }

            return {
              ...c,
              activeFiles: next,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      deactivateFile: (conversationId, fileId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.activeFiles ?? [];
            const next = existing.filter((f) => f.id !== fileId);
            return {
              ...c,
              activeFiles: next,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      updateFileProcessedContent: (conversationId, fileId, content) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.activeFiles ?? [];
            const next: ActiveFile[] = existing.map(
              (f): ActiveFile =>
                f.id === fileId
                  ? ({
                      ...f,
                      status: 'ready',
                      processedContent: content,
                      lastUsedAt: new Date().toISOString(),
                    } as ActiveFile)
                  : (f as ActiveFile),
            );
            return {
              ...c,
              activeFiles: next,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      clearAllActiveFiles: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, activeFiles: [], updatedAt: new Date().toISOString() }
              : c,
          ),
        })),

      setPinned: (conversationId, fileId, pinned) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.activeFiles ?? [];
            const next = existing.map((f) =>
              f.id === fileId ? { ...f, pinned } : f,
            );
            return {
              ...c,
              activeFiles: next,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
    }),
    {
      name: 'conversation-storage',
      version: 3, // Incremented for active files + message ids migration
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        selectedConversationId: state.selectedConversationId,
        folders: state.folders,
      }),
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as {
          conversations: Conversation[];
          selectedConversationId: string | null;
          folders: FolderInterface[];
        };

        if (version < 2) {
          // Migrate conversations to new format with message versioning
          const migratedConversations = state.conversations.map((conv) => ({
            ...conv,
            messages: needsMigration(conv.messages)
              ? migrateLegacyMessages(conv.messages as never[])
              : conv.messages,
          }));
          return { ...state, conversations: migratedConversations };
        }
        // Phase 1: Add message ids and initialize active files
        if (version < 3) {
          const { v4: uuidv4 } = require('uuid');
          const migratedConversations = state.conversations.map((conv) => {
            const messages = [...conv.messages];
            // Assign ids only to legacy Message entries (not groups)
            const withIds = messages.map((entry: any) => {
              if (isAssistantMessageGroup(entry)) return entry;
              if (typeof entry === 'object') {
                return entry.id ? entry : { ...entry, id: uuidv4() };
              }
              return entry;
            });

            return {
              ...conv,
              messages: withIds,
              activeFiles: conv.activeFiles ?? [],
              activeFilesMaxCount: conv.activeFilesMaxCount ?? 10,
            } as Conversation;
          });
          return { ...state, conversations: migratedConversations };
        }
        return state;
      },
      onRehydrateStorage: () => (state) => {
        // Mark as loaded after hydration
        if (state) {
          state.isLoaded = true;
        }
      },
    },
  ),
);
