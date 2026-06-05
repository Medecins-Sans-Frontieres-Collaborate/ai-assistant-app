'use client';

import toast from 'react-hot-toast';

import { perConversationStorage } from '@/lib/utils/app/storage/perConversationStorage';
import {
  migrateLegacyMessages,
  needsMigration,
} from '@/lib/utils/shared/chat/messageVersioning';

import {
  ActiveFile,
  AssistantMessageVersion,
  Conversation,
  ToolCallRecord,
  isAssistantMessageGroup,
} from '@/types/chat';
import { FolderInterface } from '@/types/folder';

import {
  ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT,
  ACTIVE_FILE_CONTENT_MAX_BYTES,
  ACTIVE_FILE_PIN_TOKEN_LIMIT,
  ACTIVE_FILE_SESSION_QUOTA,
} from '@/lib/constants/activeFileQuotas';
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
  deductActiveFilesTokens: (conversationId: string, tokens: number) => void;
  /**
   * Persists an MCP tool-approval outcome on the source message. Index points
   * at the message that emitted the approval request; we update its
   * `approvalOutcomes` map so re-render uses the resolved state. The
   * optional `source` records *how* the approval resolved so the UI can
   * distinguish a manual click from an auto-approve match (used by the
   * consent card to suppress display for auto-approved tools).
   */
  recordApprovalOutcome: (
    conversationId: string,
    messageIndex: number,
    approvalRequestId: string,
    approve: boolean,
    source?: 'manual' | 'auto-approved' | 'auto-denied',
  ) => void;
  /**
   * Sets the conversation's auto-approve scope. `mode: 'tool'` adds toolName
   * to the per-tool allowlist; `mode: 'all'` enables blanket auto-approval
   * for every MCP tool prompt in the conversation.
   */
  setAutoApprove: (
    conversationId: string,
    mode: 'tool' | 'all',
    toolName?: string,
  ) => void;
  /**
   * Clears every auto-approve flag (per-tool list + "all tools" flag) on
   * the conversation, returning future approval prompts to manual confirm.
   * Used by the ChatTopbar "Reset tool permissions" affordance.
   */
  resetAutoApprove: (conversationId: string) => void;
  /**
   * Persists a batch of MCP tool-call records on the source message so the
   * tool usage summary survives reload. Replaces any existing records on
   * the message (records carry their own ids; the stream is authoritative).
   */
  recordToolCalls: (
    conversationId: string,
    messageIndex: number,
    toolCalls: ToolCallRecord[],
  ) => void;
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
          // Remove folder from conversations (with updatedAt so the change persists)
          conversations: state.conversations.map((c) =>
            c.folderId === id
              ? { ...c, folderId: null, updatedAt: new Date().toISOString() }
              : c,
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
      activateFile: (conversationId, file) => {
        // Reject files that already have a token estimate exceeding the limit
        if (
          file.processedContent?.tokenEstimate &&
          file.processedContent.tokenEstimate >
            ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT
        ) {
          toast.error(
            `File too large for active context (${file.processedContent.tokenEstimate.toLocaleString()} tokens, limit: ${ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT.toLocaleString()})`,
          );
          return;
        }

        // Byte-size guard — the token estimate can be missing or inaccurate,
        // but `content.length` cannot. Without this, a large PDF whose token
        // estimate failed to compute could blow past the 5MB localStorage
        // budget when persisted into the conversation.
        const contentBytes = file.processedContent?.content?.length ?? 0;
        if (contentBytes > ACTIVE_FILE_CONTENT_MAX_BYTES) {
          toast.error(
            `File too large for active context (${(contentBytes / 1_000_000).toFixed(1)}MB extracted, limit: ${(ACTIVE_FILE_CONTENT_MAX_BYTES / 1_000_000).toFixed(0)}MB)`,
          );
          return;
        }

        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const existing = c.activeFiles ?? [];

            // Deduplicate by url — same file should not appear twice
            const alreadyExists = existing.some((f) => f.url === file.url);
            let next = alreadyExists ? existing : [...existing, file];

            // If exceeding 5 files, remove oldest unpinned files
            const MAX_FILES = c.activeFilesMaxCount ?? 5;
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
        }));
      },

      deactivateFile: (conversationId, fileId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.activeFiles ?? [];
            const next = existing.filter((f) => f.id !== fileId);
            return {
              ...c,
              activeFiles: next,
              // Reset quota when all files are removed
              ...(next.length === 0 ? { activeFilesTokensUsed: 0 } : {}),
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      updateFileProcessedContent: (conversationId, fileId, content) => {
        // Server-extracted content is unbounded; without this guard a large
        // document instantly trips QuotaExceededError on the next persist.
        // Mirrors the byte-cap that `activateFile` enforces up-front.
        let safeContent = content;
        const contentBytes = content.content?.length ?? 0;
        if (contentBytes > ACTIVE_FILE_CONTENT_MAX_BYTES) {
          safeContent = {
            ...content,
            content:
              (content.content ?? '').slice(0, ACTIVE_FILE_CONTENT_MAX_BYTES) +
              '\n\n[Content truncated to fit storage budget]',
          };
          toast.error(
            `Extracted content exceeds ${(ACTIVE_FILE_CONTENT_MAX_BYTES / 1_000_000).toFixed(0)}MB; truncated for storage.`,
          );
        }
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
                      processedContent: safeContent,
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
        }));
      },

      clearAllActiveFiles: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  activeFiles: [],
                  activeFilesTokensUsed: 0,
                  updatedAt: new Date().toISOString(),
                }
              : c,
          ),
        })),

      setPinned: (conversationId, fileId, pinned) => {
        if (pinned) {
          // Check pin threshold before allowing
          const state = get();
          const conv = state.conversations.find((c) => c.id === conversationId);
          const file = conv?.activeFiles?.find((f) => f.id === fileId);
          if (
            file?.processedContent?.tokenEstimate &&
            file.processedContent.tokenEstimate > ACTIVE_FILE_PIN_TOKEN_LIMIT
          ) {
            toast.error(
              `File too large to pin (${file.processedContent.tokenEstimate.toLocaleString()} tokens, limit: ${ACTIVE_FILE_PIN_TOKEN_LIMIT.toLocaleString()})`,
            );
            return;
          }
        }

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
        }));
      },

      deductActiveFilesTokens: (conversationId, tokens) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const newTotal = (c.activeFilesTokensUsed ?? 0) + tokens;
            return {
              ...c,
              activeFilesTokensUsed: newTotal,
              updatedAt: new Date().toISOString(),
            };
          }),
        }));

        // Check if quota is exhausted and auto-clear
        const conv = get().conversations.find((c) => c.id === conversationId);
        if (
          conv &&
          (conv.activeFilesTokensUsed ?? 0) >= ACTIVE_FILE_SESSION_QUOTA
        ) {
          get().clearAllActiveFiles(conversationId);
          toast('Active files session quota reached. Files have been cleared.');
        }
      },

      setAutoApprove: (conversationId, mode, toolName) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            if (mode === 'all') {
              return {
                ...c,
                alwaysApproveAllTools: true,
                updatedAt: new Date().toISOString(),
              };
            }
            if (mode === 'tool' && toolName) {
              const existing = c.alwaysApproveTools ?? [];
              if (existing.includes(toolName)) return c;
              return {
                ...c,
                alwaysApproveTools: [...existing, toolName],
                updatedAt: new Date().toISOString(),
              };
            }
            return c;
          }),
        })),

      recordApprovalOutcome: (
        conversationId,
        messageIndex,
        approvalRequestId,
        approve,
        source,
      ) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];
            if (!entry) return c;

            if (isAssistantMessageGroup(entry)) {
              const versions = [...entry.versions];
              const active = versions[entry.activeIndex];
              if (active) {
                versions[entry.activeIndex] = {
                  ...active,
                  approvalOutcomes: {
                    ...(active.approvalOutcomes ?? {}),
                    [approvalRequestId]: approve,
                  },
                  approvalSources: source
                    ? {
                        ...(active.approvalSources ?? {}),
                        [approvalRequestId]: source,
                      }
                    : active.approvalSources,
                };
                messages[messageIndex] = { ...entry, versions };
              }
            } else {
              messages[messageIndex] = {
                ...entry,
                approvalOutcomes: {
                  ...(entry.approvalOutcomes ?? {}),
                  [approvalRequestId]: approve,
                },
                approvalSources: source
                  ? {
                      ...(entry.approvalSources ?? {}),
                      [approvalRequestId]: source,
                    }
                  : entry.approvalSources,
              };
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),

      resetAutoApprove: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const hadState =
              !!c.alwaysApproveAllTools ||
              (c.alwaysApproveTools && c.alwaysApproveTools.length > 0);
            if (!hadState) return c;
            return {
              ...c,
              alwaysApproveAllTools: false,
              alwaysApproveTools: [],
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      recordToolCalls: (conversationId, messageIndex, toolCalls) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            if (toolCalls.length === 0) return c;

            const messages = [...c.messages];
            const entry = messages[messageIndex];
            if (!entry) return c;

            if (isAssistantMessageGroup(entry)) {
              const versions = [...entry.versions];
              const active = versions[entry.activeIndex];
              if (active) {
                versions[entry.activeIndex] = {
                  ...active,
                  toolCalls,
                };
                messages[messageIndex] = { ...entry, versions };
              }
            } else {
              messages[messageIndex] = { ...entry, toolCalls };
            }

            return { ...c, messages, updatedAt: new Date().toISOString() };
          }),
        })),
    }),
    {
      name: 'conversation-storage',
      version: 5, // v5: per-conversation localStorage keys for corruption resilience
      storage: createJSONStorage(() => perConversationStorage),
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

        // Guard against completely invalid state from corrupted storage
        if (!state || !Array.isArray(state.conversations)) {
          return {
            conversations: [],
            selectedConversationId: null,
            folders: [],
          };
        }

        if (version < 2) {
          // Migrate conversations to new format with message versioning
          state.conversations = state.conversations.map((conv) => ({
            ...conv,
            messages: needsMigration(conv.messages)
              ? migrateLegacyMessages(conv.messages as never[])
              : conv.messages,
          }));
        }

        if (version < 3) {
          // Add message ids and initialize active files
          const { v4: uuidv4 } = require('uuid');
          state.conversations = state.conversations.map((conv) => {
            const withIds = conv.messages.map((entry: any) => {
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
        }

        if (version < 4) {
          // Initialize activeFilesTokensUsed on existing conversations
          state.conversations = state.conversations.map((conv) => ({
            ...conv,
            activeFilesTokensUsed: conv.activeFilesTokensUsed ?? 0,
          }));
        }

        return state;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('[ConversationStore] Hydration error:', error);
        }
        // Mark as loaded after hydration (even on error, to prevent blocking the app)
        if (state) {
          state.isLoaded = true;
        }
      },
    },
  ),
);
