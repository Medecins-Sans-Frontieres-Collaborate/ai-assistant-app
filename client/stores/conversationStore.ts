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
  MessageToolArtifacts,
  ToolCallRecord,
  isAssistantMessageGroup,
} from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { WorkflowState, isConversationWorkflowType } from '@/types/workflow';

import {
  ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT,
  ACTIVE_FILE_CONTENT_MAX_BYTES,
  ACTIVE_FILE_PIN_TOKEN_LIMIT,
  ACTIVE_FILE_SESSION_QUOTA,
} from '@/lib/constants/activeFileQuotas';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Fire-and-forget cleanup of Azure AI Foundry threads tied to deleted
 * conversations. Server is best-effort: a network blip must never block
 * the local state mutation that calls us.
 */
function deleteAzureThreads(threadIds: (string | undefined)[]): void {
  const ids = Array.from(
    new Set(
      threadIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  );
  if (ids.length === 0) return;
  void fetch('/api/chat/agents/threads', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadIds: ids }),
  }).catch((err) => {
    console.warn('[ConversationStore] Thread cleanup request failed', err);
  });
}

/**
 * Backup tombstones are capped so the persisted blob stays bounded; beyond
 * the cap the OLDEST deletions are evicted (their remote copies then win any
 * later merge, which is the safe failure mode).
 */
const MAX_CONVERSATION_TOMBSTONES = 500;

function withTombstones(
  existing: Record<string, string>,
  ids: string[],
  deletedAt: string,
): Record<string, string> {
  if (ids.length === 0) return existing;
  const next = { ...existing };
  for (const id of ids) next[id] = deletedAt;
  const entries = Object.entries(next);
  if (entries.length <= MAX_CONVERSATION_TOMBSTONES) return next;
  entries.sort((a, b) => a[1].localeCompare(b[1]));
  return Object.fromEntries(
    entries.slice(entries.length - MAX_CONVERSATION_TOMBSTONES),
  );
}

interface ConversationStore {
  // State
  conversations: Conversation[];
  selectedConversationId: string | null;
  folders: FolderInterface[];
  searchTerm: string;
  isLoaded: boolean;
  /**
   * Deletion tombstones for the encrypted-backup sync: conversation id →
   * ISO deletedAt. Stamped by deleteConversation/clearAll, cleared per-id
   * after a sync confirms the deletion reached the remote manifest.
   */
  deletedConversations: Record<string, string>;
  /**
   * ISO timestamp of the last local folder mutation. Null = no local folder
   * state to back up (the backup folders blob is then pull-only).
   */
  foldersUpdatedAt: string | null;

  // Conversation actions
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  /**
   * Updates a workflow conversation's persisted workflow state. Refuses
   * (warn + no-op) when the updater returns a state whose `kind` does not
   * match the conversation's `conversationType`. Workflow code must use
   * this instead of raw updateConversation for state writes.
   */
  updateWorkflowState: (
    id: string,
    updater: (prev: WorkflowState | undefined) => WorkflowState,
  ) => void;
  deleteConversation: (id: string) => void;
  selectConversation: (id: string | null) => void;
  setIsLoaded: (isLoaded: boolean) => void;

  // Folder actions
  /**
   * Replaces the folders array. `updatedAt` overrides the folders
   * last-modified stamp — the backup sync passes the REMOTE timestamp when
   * applying pulled folders so the whole-LWW comparison converges instead
   * of ping-ponging pushes. Defaults to "now" (a local mutation).
   */
  setFolders: (folders: FolderInterface[], updatedAt?: string) => void;
  addFolder: (folder: FolderInterface) => void;
  updateFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;

  // Search
  setSearchTerm: (term: string) => void;

  // Bulk operations
  clearAll: () => void;

  /** Drops backup tombstones a successful sync has resolved. */
  clearSyncedTombstones: (ids: string[]) => void;

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
  /**
   * Flags the active file backed by `fileUrl` as failed (the server reported
   * its blob gone — uploads expire after a few days) and unpins it so it
   * stops counting as good context and the eviction logic can reclaim its
   * slot. Keyed by URL, not id, because the server only knows the URL.
   */
  markActiveFileError: (
    conversationId: string,
    fileUrl: string,
    errorMessage: string,
  ) => void;
  /**
   * Removes every `file_url` content part matching `fileUrl` from the
   * conversation's message history, leaving an inline note in its place
   * (client-side mirror of the server's sanitizeFileUrlsOnError, but
   * URL-targeted). Without this, FileProcessor's history walk-back would
   * re-validate the dead blob on every future turn and fail the whole
   * conversation forever.
   */
  stripExpiredFileFromMessages: (
    conversationId: string,
    fileUrl: string,
  ) => void;
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

/**
 * Applies an artifact update to the addressed message — the active version when
 * it's a regenerated group, or the entry itself for a legacy message — and
 * bumps `updatedAt`. Leaves the conversation untouched when it doesn't match or
 * the index is empty. Shared by `recordApprovalOutcome` and `recordToolCalls`.
 */
function applyMessageArtifacts(
  conversations: Conversation[],
  conversationId: string,
  messageIndex: number,
  update: (current: MessageToolArtifacts) => Partial<MessageToolArtifacts>,
): Conversation[] {
  return conversations.map((c) => {
    if (c.id !== conversationId) return c;

    const messages = [...c.messages];
    const entry = messages[messageIndex];
    if (!entry) return c;

    if (isAssistantMessageGroup(entry)) {
      const versions = [...entry.versions];
      const active = versions[entry.activeIndex];
      if (active) {
        versions[entry.activeIndex] = { ...active, ...update(active) };
        messages[messageIndex] = { ...entry, versions };
      }
    } else {
      messages[messageIndex] = { ...entry, ...update(entry) };
    }

    return { ...c, messages, updatedAt: new Date().toISOString() };
  });
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
      deletedConversations: {},
      foldersUpdatedAt: null,

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
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c;
            let patch = updates;
            // conversationType is settled by the first message, not by the
            // first selection: WorkflowTabs lets the user switch modes (and
            // back to plain chat) freely while the conversation is empty.
            // Once it has messages the type is fixed, so a stale render or
            // a rogue caller can't re-type a live conversation.
            if (
              c.messages.length > 0 &&
              'conversationType' in updates &&
              updates.conversationType !== c.conversationType
            ) {
              console.warn(
                '[ConversationStore] Ignoring attempt to change conversationType of',
                id,
              );
              // workflowState travels with conversationType — dropping only
              // the type would leave a state whose `kind` disagrees with it.
              const {
                conversationType: _ignoredType,
                workflowState: _ignoredState,
                ...rest
              } = updates;
              patch = rest;
            }
            return { ...c, ...patch, updatedAt: new Date().toISOString() };
          }),
        })),

      updateWorkflowState: (id, updater) =>
        set((state) => {
          let changed = false;
          const conversations = state.conversations.map((c) => {
            if (c.id !== id) return c;
            const next = updater(c.workflowState);
            // Updaters may return the previous state unchanged (same
            // reference) to signal "nothing to write" — treat as a no-op
            // so subscribers aren't re-notified and no persistence runs.
            // Breaks feedback loops like map moveend → write → re-render.
            if (next === c.workflowState) return c;
            if (next.kind !== c.conversationType) {
              console.warn(
                '[ConversationStore] workflowState kind mismatch for',
                id,
                '- expected',
                c.conversationType,
                'got',
                next.kind,
              );
              return c;
            }
            if (process.env.NODE_ENV !== 'production') {
              // Soft budget: workflow state must stay small (references and
              // bounded text, not blobs) to protect the localStorage quota.
              const size = JSON.stringify(next).length;
              if (size > 200_000) {
                console.warn(
                  `[ConversationStore] workflowState for ${id} is ${size} bytes; keep large payloads in files, not state`,
                );
              }
            }
            changed = true;
            return {
              ...c,
              workflowState: next,
              updatedAt: new Date().toISOString(),
            };
          });
          // Same state object = zustand skips notify entirely.
          return changed ? { conversations } : state;
        }),

      deleteConversation: (id) => {
        const target = get().conversations.find((c) => c.id === id);
        if (target?.threadId) {
          deleteAzureThreads([target.threadId]);
        }
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          selectedConversationId:
            state.selectedConversationId === id
              ? null
              : state.selectedConversationId,
          deletedConversations: withTombstones(
            state.deletedConversations,
            [id],
            new Date().toISOString(),
          ),
        }));
      },

      selectConversation: (id) => set({ selectedConversationId: id }),

      setIsLoaded: (isLoaded) => set({ isLoaded }),

      // Folder actions
      setFolders: (folders, updatedAt) =>
        set({
          folders,
          foldersUpdatedAt: updatedAt ?? new Date().toISOString(),
        }),

      addFolder: (folder) =>
        set((state) => ({
          folders: [...state.folders, folder],
          foldersUpdatedAt: new Date().toISOString(),
        })),

      updateFolder: (id, name) =>
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
          foldersUpdatedAt: new Date().toISOString(),
        })),

      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          foldersUpdatedAt: new Date().toISOString(),
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
      clearAll: () => {
        const cleared = get().conversations;
        deleteAzureThreads(cleared.map((c) => c.threadId));
        const now = new Date().toISOString();
        set((state) => ({
          conversations: [],
          selectedConversationId: null,
          folders: [],
          searchTerm: '',
          deletedConversations: withTombstones(
            state.deletedConversations,
            cleared.map((c) => c.id),
            now,
          ),
          foldersUpdatedAt: now,
        }));
      },

      clearSyncedTombstones: (ids) =>
        set((state) => {
          const next = { ...state.deletedConversations };
          let changed = false;
          for (const id of ids) {
            if (id in next) {
              delete next[id];
              changed = true;
            }
          }
          // Same state object = zustand skips notify entirely.
          return changed ? { deletedConversations: next } : state;
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

      markActiveFileError: (conversationId, fileUrl, errorMessage) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.activeFiles ?? [];
            if (!existing.some((f) => f.url === fileUrl)) return c;
            return {
              ...c,
              activeFiles: existing.map((f) =>
                f.url === fileUrl
                  ? {
                      ...f,
                      status: 'error' as const,
                      errorMessage,
                      pinned: false,
                    }
                  : f,
              ),
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      stripExpiredFileFromMessages: (conversationId, fileUrl) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            let changed = false;
            const messages = c.messages.map((entry) => {
              // file_url parts only exist on plain (user) messages.
              if (isAssistantMessageGroup(entry)) return entry;
              if (!Array.isArray(entry.content)) return entry;

              const removed = entry.content.find(
                (part) => part.type === 'file_url' && part.url === fileUrl,
              );
              if (!removed) return entry;
              changed = true;

              const kept = entry.content.filter(
                (part) => !(part.type === 'file_url' && part.url === fileUrl),
              );
              const filename =
                'originalFilename' in removed && removed.originalFilename
                  ? ` "${removed.originalFilename}"`
                  : '';
              const notice = `[Note: The attached file${filename} is no longer available and was removed]`;

              // Prepend the notice to an existing text part, or add one.
              const textIndex = kept.findIndex((part) => part.type === 'text');
              const withNotice =
                textIndex >= 0
                  ? kept.map((part, i) =>
                      i === textIndex && part.type === 'text'
                        ? { ...part, text: `${notice}\n\n${part.text}` }
                        : part,
                    )
                  : [{ type: 'text' as const, text: notice }, ...kept];

              // Collapse to a plain string when only text remains — the
              // same shape the server's sanitizer produces.
              const only = withNotice.length === 1 ? withNotice[0] : null;
              return {
                ...entry,
                content: only && only.type === 'text' ? only.text : withNotice,
              };
            });
            if (!changed) return c;
            return {
              ...c,
              messages,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

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
          conversations: applyMessageArtifacts(
            state.conversations,
            conversationId,
            messageIndex,
            (current) => ({
              approvalOutcomes: {
                ...(current.approvalOutcomes ?? {}),
                [approvalRequestId]: approve,
              },
              approvalSources: source
                ? {
                    ...(current.approvalSources ?? {}),
                    [approvalRequestId]: source,
                  }
                : current.approvalSources,
            }),
          ),
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
        set((state) => {
          if (toolCalls.length === 0) return state;
          return {
            conversations: applyMessageArtifacts(
              state.conversations,
              conversationId,
              messageIndex,
              () => ({ toolCalls }),
            ),
          };
        }),
    }),
    {
      name: 'conversation-storage',
      version: 7, // v7: backup tombstones (deletedConversations) + foldersUpdatedAt
      storage: createJSONStorage(() => perConversationStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        selectedConversationId: state.selectedConversationId,
        folders: state.folders,
        deletedConversations: state.deletedConversations,
        foldersUpdatedAt: state.foldersUpdatedAt,
      }),
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as {
          conversations: Conversation[];
          selectedConversationId: string | null;
          folders: FolderInterface[];
          deletedConversations?: Record<string, string>;
          foldersUpdatedAt?: string | null;
        };

        // Guard against completely invalid state from corrupted storage
        if (!state || !Array.isArray(state.conversations)) {
          return {
            conversations: [],
            selectedConversationId: null,
            folders: [],
            deletedConversations: {},
            foldersUpdatedAt: null,
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

        if (version < 6) {
          // Conversation workflows: normalize any invalid workflow fields
          // (defensive against imported or hand-edited conversations).
          state.conversations = state.conversations.map((conv) => {
            if (
              conv.conversationType &&
              !isConversationWorkflowType(conv.conversationType)
            ) {
              const {
                conversationType: _type,
                workflowState: _state,
                ...rest
              } = conv;
              return rest as Conversation;
            }
            if (
              conv.workflowState &&
              conv.workflowState.kind !== conv.conversationType
            ) {
              const { workflowState: _state, ...rest } = conv;
              return rest as Conversation;
            }
            return conv;
          });
        }

        if (version < 7) {
          // Encrypted backup: start with no tombstones; pre-existing folders
          // get a fresh last-modified stamp so the first sync pushes them
          // (null would leave them pull-only and never backed up).
          state.deletedConversations = {};
          state.foldersUpdatedAt =
            Array.isArray(state.folders) && state.folders.length > 0
              ? new Date().toISOString()
              : null;
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
