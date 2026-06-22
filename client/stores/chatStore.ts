'use client';

import toast from 'react-hot-toast';

import { generateConversationTitle } from '@/client/services/titleService';

import { findMessageIndexForApprovalId } from '@/lib/utils/shared/chat/findMessageIndexForApprovalId';
import { MessageContentAnalyzer } from '@/lib/utils/shared/chat/messageContentAnalyzer';
import {
  createMessageGroup,
  entryToDisplayMessage,
  flattenEntriesForAPI,
  messageToVersion,
} from '@/lib/utils/shared/chat/messageVersioning';
import { windowMessagesForAPI } from '@/lib/utils/shared/chat/messageWindowing';
import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { AgentType } from '@/types/agent';
import {
  ActiveFile,
  ApprovalResponse,
  ConsentRequest,
  Conversation,
  Message,
  MessageType,
  ToolCallRecord,
} from '@/types/chat';
import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  fallbackModelID,
} from '@/types/openai';
import { Citation } from '@/types/rag';
import { SearchMode } from '@/types/searchMode';

import { useConversationStore } from './conversationStore';
import { useSettingsStore } from './settingsStore';
import { useUIStore } from './uiStore';

import { ApiError, chatService } from '@/client/services';
import { getFallbackModel } from '@/config/models';
import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { ConsentRequestPayload } from '@/lib/streamMarkers';
import { create } from 'zustand';

/** Sentinel key for OAuth resume state when a server has no label. */
const NO_SERVER_LABEL = '__no_label__';

/** Returns a new Set without `item`, or the same set when `item` isn't present
 *  (so an unchanged value keeps its reference and avoids a needless re-render). */
function setWithout<T>(set: Set<T>, item: T): Set<T> {
  if (!set.has(item)) return set;
  const next = new Set(set);
  next.delete(item);
  return next;
}

/**
 * Builds the finalized assistant message from streamed content, attaching tool
 * calls and consent requests only when present. Shared by the send, retry, and
 * approval-resume paths so they stay consistent.
 */
function buildAssistantMessage(
  streamParser: StreamParser,
  finalContent: string,
  toolCalls?: ToolCallRecord[],
  consentRequests?: ConsentRequest[],
): Message {
  const assistantMessage = streamParser.toMessage(finalContent);
  if (toolCalls && toolCalls.length > 0) {
    assistantMessage.toolCalls = toolCalls;
  }
  if (consentRequests && consentRequests.length > 0) {
    assistantMessage.consentRequests = consentRequests;
  }
  return assistantMessage;
}

interface ChatStore {
  // State
  currentMessage: Message | undefined;
  isStreaming: boolean;
  streamingContent: string;
  streamingConversationId: string | null;
  citations: Citation[];
  error: string | null;
  stopRequested: boolean;
  loadingMessage: string | null;
  /**
   * Interpolation params for `loadingMessage` when the translation key has
   * placeholders (e.g. {tool} for "Using {tool}…"). Set alongside
   * `loadingMessage` from live agent-activity markers carrying params.
   */
  loadingMessageParams: Record<string, string> | undefined;
  /** Live consent prompts during streaming, already extracted from markers. */
  streamingConsentRequests: ConsentRequestPayload[];
  /** Live tool call records during streaming; rendered as the summary. */
  streamingToolCalls: ToolCallRecord[];
  abortController: AbortController | null;

  // Retry-related state
  isRetrying: boolean;
  retryWithFallback: boolean;
  originalModelId: string | null;
  /**
   * The fallback-chain model that actually produced the successful retry —
   * the switch prompt and acceptModelSwitch must reference this model, not
   * the first entry of the chain, since the chain may have advanced.
   */
  successfulFallbackModelId: string | null;
  showModelSwitchPrompt: boolean;
  failedConversation: Conversation | null;
  failedSearchMode: SearchMode | undefined;
  successfulRetryConversationId: string | null;
  /**
   * False when the current error is not safely retriable (e.g. the server
   * rejected the request because a message in this conversation's history
   * is corrupted — regenerating would fail the same way). The UI uses this
   * to hide the Regenerate button.
   */
  errorIsRecoverable: boolean;

  // Regeneration state for message versioning
  regeneratingIndex: number | null;

  /**
   * IDs of active files that were not injected on the most recent turn,
   * keyed by conversation ID. The `last` in the name is from the *next*
   * send's perspective: the server emits these as
   * `ChatContext.activeFilesDroppedThisTurn` on completion, this store
   * keeps them around as "last turn" until the *next* successful turn
   * populates them again. They are intentionally NOT cleared on send
   * start — if a stream fails mid-flight, the previous turn's badges
   * stay visible so the user keeps an accurate picture.
   */
  lastTurnDroppedActiveFileIds: Record<string, string[]>;

  /**
   * Map of MCP approval_request_id → user decision (true=approve). Resolved
   * approvals are stored here so the consent card can render its "Approved"
   * / "Denied" terminal state without re-prompting. Reset per page load —
   * the durable copy lives on the source message in the conversation store.
   */
  submittedApprovals: Map<string, boolean>;
  /** Set of approval_request_id currently in flight (card UI shows spinner). */
  submittingApprovals: Set<string>;
  /** Approval ids that errored or were aborted. Prevents the auto-approve
   *  effect from retrying the same id indefinitely after a failure. */
  failedApprovals: Set<string>;

  /**
   * Per-server "Continue in flight" markers, keyed by server label
   * (empty string for null/unknown server). The next assistant message
   * for a given server either contains real content (sign-in succeeded
   * — clear the key) or another `oauth_consent_request` (sign-in didn't
   * complete — the card uses the matching key to switch to "incomplete
   * sign-in" framing). Keyed by server so a multi-server chat (e.g.
   * NetSuite + Salesforce) doesn't lose state when one in-flight resume
   * overwrites another.
   */
  pendingOAuthResume: Record<string, { at: number }>;

  setPendingOAuthResume: (info: { serverLabel: string | null } | null) => void;
  clearPendingOAuthResumeFor: (serverLabel: string | null) => void;
  /** Drops the failed-approval guard set. Called on conversation switch so
   *  prior failures don't persistently block auto-approve on the same id. */
  clearFailedApprovals: () => void;

  // Actions
  setRegeneratingIndex: (index: number | null) => void;
  setLastTurnDroppedActiveFileIds: (
    conversationId: string,
    fileIds: string[],
  ) => void;
  setCurrentMessage: (message: Message | undefined) => void;
  setIsStreaming: (isStreaming: boolean) => void;
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (chunk: string) => void;
  setCitations: (citations: Citation[]) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  requestStop: () => void;
  resetStop: () => void;
  resetChat: () => void;
  setLoadingMessage: (
    message: string | null,
    params?: Record<string, string>,
  ) => void;
  sendMessage: (
    message: Message,
    conversation: Conversation,
    searchMode?: SearchMode,
  ) => Promise<void>;

  // Helper methods for sendMessage
  initializeStreamingState: (
    conversationId: string,
    loadingMessage: string,
  ) => void;
  scheduleLoadingMessage: (loadingMessage: string) => NodeJS.Timeout;
  sendChatRequest: (
    conversation: Conversation,
    searchMode?: SearchMode,
    approvalResponses?: ApprovalResponse[],
  ) => Promise<ReadableStream<Uint8Array>>;

  /**
   * Submits a user decision for an MCP tool-approval prompt. Sends the
   * approval response back through the chat pipeline so the server can
   * resume the agent's response stream. The conversation's source message
   * is updated via `recordApprovalOutcome` on the conversation store after
   * the stream finalizes successfully.
   *
   * `source` records *how* the approval resolved — manual click vs an
   * `alwaysApprove*` match — so the tool usage summary can label
   * auto-approved calls accordingly and the consent card can suppress
   * its display when the user never had a choice.
   */
  submitApproval: (
    approvalRequestId: string,
    approve: boolean,
    conversation: Conversation,
    sourceMessageIndex?: number,
    source?: 'manual' | 'auto-approved' | 'auto-denied',
  ) => Promise<void>;
  processStream: (
    stream: ReadableStream<Uint8Array>,
    streamParser: StreamParser,
    showLoadingTimeout: NodeJS.Timeout | null,
  ) => Promise<{
    finalContent: string;
    threadId?: string;
    pendingTranscriptions?: {
      filename: string;
      jobId: string;
      blobPath?: string;
      totalChunks?: number;
      jobType?: 'chunked' | 'batch';
    }[];
    fileCacheUpdates?: Array<{
      fileId: string;
      processedContent: {
        type: 'document' | 'transcript' | 'image';
        content: string;
        summary?: string;
        tokenEstimate: number;
        tokenEstimateEncoding?: string;
        processedAt: string;
      };
    }>;
    activeFilesTokensConsumed?: number;
    activeFilesDropped?: string[];
    /** MCP tool calls observed in the stream, for the post-stream summary. */
    toolCalls?: ToolCallRecord[];
    /** Consent prompts emitted in the stream — persisted onto the assistant
     *  message so a card-only turn still renders after finalization. */
    consentRequests?: ConsentRequest[];
  }>;
  finalizeMessage: (
    assistantMessage: Message,
    conversation: Conversation,
    threadId?: string,
    pendingTranscriptions?: {
      filename: string;
      jobId: string;
      blobPath?: string;
      totalChunks?: number;
      jobType?: 'chunked' | 'batch';
    }[],
  ) => Promise<void>;
  generateConversationName: (firstUserMessage: Message) => string | null;
  clearStreamingState: () => void;
  handleSendError: (
    error: unknown,
    conversation?: Conversation,
    searchMode?: SearchMode,
  ) => void;

  // Retry-related actions
  retryWithFallbackModel: (
    conversation: Conversation,
    searchMode?: SearchMode,
    attemptedModelIds?: string[],
  ) => Promise<void>;
  /**
   * Re-sends the trailing user message of the failed conversation. Used
   * when the stream errored before any assistant content arrived —
   * `handleRegenerate` is a no-op in that case because there's no
   * assistant group to append a version to.
   */
  retryFailedRequest: () => Promise<void>;
  dismissModelSwitchPrompt: () => void;
  acceptModelSwitch: (alwaysSwitch?: boolean) => void;

  // Pending transcription state (for async chunked/batch transcription)
  pendingConversationTranscription: {
    conversationId: string;
    jobId: string;
    messageIndex: number;
    filename: string;
    blobPath?: string; // Only for batch jobs
    startedAt: number;
    /** Total chunks, if this is a chunked job — used to scale client timeout. */
    totalChunks?: number;
    progress?: {
      completed: number;
      total: number;
    };
    /**
     * True when the status channel has had several consecutive failures but
     * hasn't yet given up — surfaced as a "Reconnecting…" hint in the UI so
     * the user knows we're still trying, rather than silently spinning.
     */
    isReconnecting?: boolean;
  } | null;
  setConversationTranscriptionPending: (
    info: {
      conversationId: string;
      jobId: string;
      messageIndex: number;
      filename: string;
      blobPath?: string;
      totalChunks?: number;
    } | null,
  ) => void;
  updateTranscriptionProgress: (completed: number, total: number) => void;
  setTranscriptionReconnecting: (isReconnecting: boolean) => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  currentMessage: undefined,
  isStreaming: false,
  streamingContent: '',
  streamingConversationId: null,
  citations: [],
  error: null,
  stopRequested: false,
  loadingMessage: null,
  loadingMessageParams: undefined,
  streamingConsentRequests: [],
  streamingToolCalls: [],
  abortController: null,

  // Retry-related initial state
  isRetrying: false,
  retryWithFallback: false,
  originalModelId: null,
  successfulFallbackModelId: null,
  showModelSwitchPrompt: false,
  failedConversation: null,
  failedSearchMode: undefined,
  successfulRetryConversationId: null,
  errorIsRecoverable: true,

  // Regeneration initial state
  regeneratingIndex: null,

  // Pending transcription initial state
  pendingConversationTranscription: null,

  // Dropped active file IDs by conversation (most recent turn only)
  lastTurnDroppedActiveFileIds: {},
  submittedApprovals: new Map<string, boolean>(),
  submittingApprovals: new Set<string>(),
  failedApprovals: new Set<string>(),
  pendingOAuthResume: {},

  setPendingOAuthResume: (info) =>
    set((state) => {
      if (info === null) return { pendingOAuthResume: {} };
      // Sentinel for the null-serverLabel case so two unrelated flows
      // without a label can't collide on the empty-string key.
      const key = info.serverLabel ?? NO_SERVER_LABEL;
      return {
        pendingOAuthResume: {
          ...state.pendingOAuthResume,
          [key]: { at: Date.now() },
        },
      };
    }),

  clearPendingOAuthResumeFor: (serverLabel) =>
    set((state) => {
      const key = serverLabel ?? NO_SERVER_LABEL;
      if (!state.pendingOAuthResume[key]) return state;
      const next = { ...state.pendingOAuthResume };
      delete next[key];
      return { pendingOAuthResume: next };
    }),

  clearFailedApprovals: () =>
    set((state) => {
      if (state.failedApprovals.size === 0) return state;
      return { failedApprovals: new Set() };
    }),

  // Actions
  setRegeneratingIndex: (index) => set({ regeneratingIndex: index }),
  setLastTurnDroppedActiveFileIds: (conversationId, fileIds) =>
    set((state) => {
      const next = { ...state.lastTurnDroppedActiveFileIds };
      if (fileIds.length === 0) delete next[conversationId];
      else next[conversationId] = fileIds;
      return { lastTurnDroppedActiveFileIds: next };
    }),

  setCurrentMessage: (message) => set({ currentMessage: message }),

  setIsStreaming: (isStreaming) => set({ isStreaming }),

  setStreamingContent: (content) => set({ streamingContent: content }),

  appendStreamingContent: (chunk) =>
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
    })),

  setCitations: (citations) => set({ citations }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),

  requestStop: () => {
    const { abortController } = get();
    if (abortController) {
      console.log('[chatStore] Aborting stream...');
      abortController.abort();
    }
    set({ stopRequested: true });
  },

  resetStop: () => set({ stopRequested: false }),

  setLoadingMessage: (message, params) =>
    set({ loadingMessage: message, loadingMessageParams: params }),

  resetChat: () =>
    set({
      currentMessage: undefined,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      citations: [],
      error: null,
      stopRequested: false,
      loadingMessage: null,
      loadingMessageParams: undefined,
      streamingConsentRequests: [],
      streamingToolCalls: [],
      abortController: null,
      // Reset retry state
      isRetrying: false,
      retryWithFallback: false,
      originalModelId: null,
      successfulFallbackModelId: null,
      showModelSwitchPrompt: false,
      failedConversation: null,
      failedSearchMode: undefined,
      successfulRetryConversationId: null,
      errorIsRecoverable: true,
      // Reset regeneration state
      regeneratingIndex: null,
      // Reset pending transcription state
      pendingConversationTranscription: null,
    }),

  setConversationTranscriptionPending: (info) =>
    set({
      pendingConversationTranscription: info
        ? { ...info, startedAt: Date.now() }
        : null,
    }),

  updateTranscriptionProgress: (completed, total) =>
    set((state) => ({
      pendingConversationTranscription: state.pendingConversationTranscription
        ? {
            ...state.pendingConversationTranscription,
            progress: { completed, total },
          }
        : null,
    })),

  setTranscriptionReconnecting: (isReconnecting) =>
    set((state) => ({
      pendingConversationTranscription: state.pendingConversationTranscription
        ? { ...state.pendingConversationTranscription, isReconnecting }
        : null,
    })),

  sendMessage: async (message, conversation, searchMode) => {
    console.log('[chatStore.sendMessage] Message toneId:', message.toneId);
    // Log messages - convert entries to display messages for logging
    const flatMessages = flattenEntriesForAPI(conversation.messages);
    console.log(
      '[chatStore.sendMessage] All messages:',
      flatMessages.map((m) => ({ role: m.role, toneId: m.toneId })),
    );

    let showLoadingTimeout: NodeJS.Timeout | null = null;

    try {
      // Use analyzer to determine loading message key (for translation in UI)
      const analyzer = new MessageContentAnalyzer(message);
      const loadingMessage = analyzer.getLoadingMessageKey();

      // Initialize streaming state
      get().initializeStreamingState(conversation.id, loadingMessage);

      // Schedule loading message display (only if response is slow)
      showLoadingTimeout = get().scheduleLoadingMessage(loadingMessage);

      // Prepare and send the API request
      const stream = await get().sendChatRequest(conversation, searchMode);

      // Process the stream
      const streamParser = new StreamParser();
      const {
        finalContent,
        threadId,
        pendingTranscriptions,
        fileCacheUpdates,
        activeFilesTokensConsumed,
        activeFilesDropped,
        toolCalls,
        consentRequests,
      } = await get().processStream(stream, streamParser, showLoadingTimeout);

      // Create assistant message
      const assistantMessage = buildAssistantMessage(
        streamParser,
        finalContent,
        toolCalls,
        consentRequests,
      );

      // Surface files that were excluded from this turn's context so the
      // ActiveFilesPanel can flag them — without this the user has no
      // way to tell that an active file silently fell out of context.
      get().setLastTurnDroppedActiveFileIds(
        conversation.id,
        activeFilesDropped ?? [],
      );

      // Handle pending transcriptions (async batch jobs for large files)
      if (pendingTranscriptions && pendingTranscriptions.length > 0) {
        // Get the message index for the user message (will be at current length - 1)
        // The assistant message will be added next, so the pending info should reference the user message
        const messageIndex = conversation.messages.length;
        const pending = pendingTranscriptions[0]; // Handle first pending transcription
        get().setConversationTranscriptionPending({
          conversationId: conversation.id,
          jobId: pending.jobId,
          messageIndex,
          filename: pending.filename,
          blobPath: pending.blobPath,
        });
      }

      // Finalize: update conversation, auto-name if needed
      await get().finalizeMessage(
        assistantMessage,
        conversation,
        threadId,
        pendingTranscriptions,
      );

      // Apply file cache updates to conversation store
      const conversationStore = useConversationStore.getState();
      if (fileCacheUpdates && fileCacheUpdates.length > 0) {
        for (const u of fileCacheUpdates) {
          if (u?.fileId && u?.processedContent) {
            conversationStore.updateFileProcessedContent(
              conversation.id,
              u.fileId,
              u.processedContent as any,
            );
          }
        }
      }

      // Auto-activate transcript as active file (sync transcription path)
      const transcript = streamParser.getTranscript();
      const isSyncTranscript =
        transcript?.transcript &&
        !transcript.transcript.startsWith('[Transcription in progress');

      if (isSyncTranscript) {
        const tokenEstimate = Math.ceil(transcript.transcript.length / 4);
        const activeFile: ActiveFile = {
          id: `transcript-sync-${Date.now()}`,
          url: `transcript://sync/${encodeURIComponent(transcript.filename)}`,
          originalFilename: `${transcript.filename}.transcript.txt`,
          addedAt: new Date().toISOString(),
          sourceMessageId: '',
          status: 'ready',
          pinned: false,
          processedContent: {
            type: 'transcript',
            content: transcript.transcript,
            tokenEstimate,
            processedAt: new Date().toISOString(),
          },
        };
        conversationStore.activateFile(conversation.id, activeFile);
      }

      // Deduct active files session quota
      if (activeFilesTokensConsumed && activeFilesTokensConsumed > 0) {
        conversationStore.deductActiveFilesTokens(
          conversation.id,
          activeFilesTokensConsumed,
        );
      }

      // Track successful model usage for ordering stability
      const { recordSuccessfulModelUsage } = useSettingsStore.getState();
      recordSuccessfulModelUsage(conversation.model.id);

      // Clear state
      get().clearStreamingState();

      // Clean up timeout
      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }
    } catch (error) {
      console.error('sendMessage error:', error);

      // Clean up timeout
      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }

      get().handleSendError(error, conversation, searchMode);
    }
  },

  // Helper methods for sendMessage

  initializeStreamingState: (
    conversationId: string,
    loadingMessage: string,
  ) => {
    // Create new AbortController for this request
    const abortController = new AbortController();

    set({
      isStreaming: true,
      streamingContent: '',
      streamingConversationId: conversationId,
      error: null,
      citations: [],
      loadingMessage: null, // Start with null, will be set after delay
      loadingMessageParams: undefined,
      streamingConsentRequests: [],
      streamingToolCalls: [],
      stopRequested: false,
      abortController,
    });

    // Dismiss any open stop-generation confirmation modal — a stale dialog
    // for the prior stream could otherwise be confirmed and accidentally
    // cancel the new request.
    useUIStore.getState().setStopGenerationConfirmSource(null);
  },

  scheduleLoadingMessage: (loadingMessage: string): NodeJS.Timeout => {
    // 150ms balances flash-prevention against perceived responsiveness.
    const loadingDelay = 150;
    return setTimeout(() => {
      const currentState = get();
      if (currentState.isStreaming && !currentState.streamingContent) {
        set({ loadingMessage });
      }
    }, loadingDelay);
  },

  sendChatRequest: async (
    conversation: Conversation,
    searchMode?: SearchMode,
    approvalResponses?: ApprovalResponse[],
  ): Promise<ReadableStream<Uint8Array>> => {
    const settings = useSettingsStore.getState();
    const modelSupportsStreaming = conversation.model.stream !== false;

    // Get latest model config - if model no longer exists, use fallback
    // Organization agents (org-*) and custom agents (custom-*) are dynamically created
    // and won't be in the static OpenAIModels map - use the conversation model directly
    const isOrganizationAgent =
      conversation.model.id.startsWith('org-') ||
      conversation.model.isOrganizationAgent;
    const isCustomAgent =
      conversation.model.id.startsWith('custom-') ||
      conversation.model.isCustomAgent;

    let latestModelConfig =
      OpenAIModels[conversation.model.id as OpenAIModelID];

    if (!latestModelConfig && !isOrganizationAgent && !isCustomAgent) {
      console.warn(
        `[chatStore] Model "${conversation.model.id}" no longer exists, using fallback model`,
      );
      // Try settings default, then the fallback chain
      const fallbackId = settings.defaultModelId || fallbackModelID;
      const rescuedModel =
        OpenAIModels[fallbackId] ?? getFallbackModel([conversation.model.id]);

      if (!rescuedModel) {
        throw new Error(
          `No valid model available. Requested: ${conversation.model.id}, Fallback: ${fallbackId}`,
        );
      }
      latestModelConfig = rescuedModel;
    }

    // For organization/custom agents, use the conversation model directly (it already has full config)
    // For base models, merge with latest config from OpenAIModels
    const modelToSend =
      isOrganizationAgent || isCustomAgent
        ? conversation.model
        : { ...conversation.model, ...latestModelConfig };

    // Approval-resume: the server only uses the approval items; skip the
    // (otherwise unused) message windowing pass and send just the trailing
    // entry to satisfy non-empty-array validators downstream.
    const messagesForAPI = approvalResponses?.length
      ? flattenEntriesForAPI(conversation.messages).slice(-1)
      : windowMessagesForAPI(flattenEntriesForAPI(conversation.messages));

    // Get the toneId from the latest user message and look up the full tone object
    const latestUserMessage = messagesForAPI
      .filter((m) => m.role === 'user')
      .pop();
    const tone = latestUserMessage?.toneId
      ? settings.tones.find((t) => t.id === latestUserMessage.toneId)
      : undefined;

    if (latestUserMessage?.toneId && tone) {
      console.log('[chatStore.sendChatRequest] Sending full tone object:', {
        id: tone.id,
        name: tone.name,
        hasVoiceRules: !!tone.voiceRules,
      });
    }

    // Get abort signal from store
    const { abortController } = get();

    const orgAgentSearchAllowed =
      isOrganizationAgent && conversation.model.id.startsWith('org-')
        ? getOrganizationAgentById(conversation.model.id.slice('org-'.length))
            ?.allowWebSearch === true
        : false;
    const isAgentInvocation = isOrganizationAgent || isCustomAgent;
    const effectiveSearchMode =
      isAgentInvocation && !orgAgentSearchAllowed ? undefined : searchMode;

    return await chatService.chat(modelToSend, messagesForAPI, {
      prompt: settings.systemPrompt,
      temperature: settings.temperature,
      stream: modelSupportsStreaming,
      botId: conversation.bot,
      threadId: conversation.threadId,
      reasoningEffort:
        conversation.reasoningEffort || modelToSend.reasoningEffort,
      verbosity: conversation.verbosity || modelToSend.verbosity,
      searchMode: effectiveSearchMode,
      tone, // Pass the full tone object
      signal: abortController?.signal, // Pass abort signal
      streamingSpeed: settings.streamingSpeed, // Pass streaming speed configuration
      includeUserInfoInPrompt: settings.includeUserInfoInPrompt,
      preferredName: settings.preferredName,
      userContext: settings.userContext,
      displayNamePreference: settings.displayNamePreference,
      customDisplayName: settings.customDisplayName,
      activeFiles: conversation.activeFiles,
      activeFilesTokensUsed: conversation.activeFilesTokensUsed ?? 0,
      autoInjectPinnedImages: settings.autoInjectPinnedImages,
      agentSourcePath: modelToSend.agentSource,
      approvalResponses,
    });
  },

  processStream: async (
    stream: ReadableStream<Uint8Array>,
    streamParser: StreamParser,
    showLoadingTimeout: NodeJS.Timeout | null,
  ): Promise<{
    finalContent: string;
    threadId?: string;
    pendingTranscriptions?: {
      filename: string;
      jobId: string;
      blobPath?: string;
      totalChunks?: number;
      jobType?: 'chunked' | 'batch';
    }[];
    fileCacheUpdates?: Array<{
      fileId: string;
      processedContent: {
        type: 'document' | 'transcript' | 'image';
        content: string;
        summary?: string;
        tokenEstimate: number;
        tokenEstimateEncoding?: string;
        processedAt: string;
      };
    }>;
    activeFilesTokensConsumed?: number;
    activeFilesDropped?: string[];
    toolCalls?: ToolCallRecord[];
    consentRequests?: ConsentRequest[];
  }> => {
    const reader = stream.getReader();

    // Coalesce burst chunks into one paint per frame (~60fps). Falls back
    // to sync `set` when requestAnimationFrame isn't available (SSR/tests).
    const canRAF =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as { requestAnimationFrame?: unknown })
        .requestAnimationFrame === 'function';
    let pendingFrame = 0;
    type PendingPatch = {
      streamingContent?: string;
      citations?: Citation[];
      loadingMessage?: string | null;
      loadingMessageParams?: Record<string, string>;
    };
    let pendingPatch: PendingPatch | null = null;
    const flush = () => {
      pendingFrame = 0;
      if (pendingPatch) {
        const patch = pendingPatch;
        pendingPatch = null;
        set(patch);
      }
    };
    const enqueuePatch = (patch: PendingPatch) => {
      pendingPatch = pendingPatch ? { ...pendingPatch, ...patch } : patch;
      if (!canRAF) {
        flush();
        return;
      }
      if (pendingFrame !== 0) return;
      pendingFrame = (
        globalThis as unknown as {
          requestAnimationFrame: (cb: (ts: number) => void) => number;
        }
      ).requestAnimationFrame(flush);
    };

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const result = streamParser.processChunk(value, { stream: true });

      // Activity updates bypass the rAF batch — rare and need to land fast.
      if (result.action && !result.hasReceivedContent) {
        set({
          loadingMessage: result.action,
          loadingMessageParams: result.actionParams,
        });
      }

      // Server-emitted outcomes (today: auto-denies on a new turn). Write
      // to the in-memory map and to the source message so reload doesn't
      // re-prompt.
      if (result.newOutcomes.length > 0) {
        set((state) => {
          const next = new Map(state.submittedApprovals);
          for (const o of result.newOutcomes) {
            next.set(o.approval_request_id, o.approve);
          }
          return { submittedApprovals: next };
        });

        const conversationId = get().streamingConversationId;
        if (conversationId) {
          const conversationStore = useConversationStore.getState();
          const conv = conversationStore.conversations.find(
            (c) => c.id === conversationId,
          );
          if (conv) {
            for (const o of result.newOutcomes) {
              const idx = findMessageIndexForApprovalId(
                conv,
                o.approval_request_id,
              );
              if (idx !== null) {
                conversationStore.recordApprovalOutcome(
                  conversationId,
                  idx,
                  o.approval_request_id,
                  o.approve,
                  o.approve ? 'auto-approved' : 'auto-denied',
                );
              }
            }
          }
        }
      }

      // Separate slices so consent + tool-call subtrees don't re-render
      // on text chunks. Skipped when nothing changed (Zustand strict eq).
      if (result.consentChanged) {
        set({ streamingConsentRequests: streamParser.getConsentRequests() });
      }
      if (result.toolCallsChanged) {
        set({ streamingToolCalls: streamParser.getToolCallRecords?.() ?? [] });
      }

      // Clear loading timeout once content arrives
      if (result.hasReceivedContent && showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
        showLoadingTimeout = null;
      }

      const currentState = get();
      const shouldClearLoading =
        result.hasReceivedContent && currentState.loadingMessage !== null;

      if (
        result.contentChanged ||
        result.citationsChanged ||
        shouldClearLoading
      ) {
        const patch: PendingPatch = {
          streamingContent: result.displayText,
          loadingMessage: result.hasReceivedContent
            ? null
            : currentState.loadingMessage,
          loadingMessageParams: result.hasReceivedContent
            ? undefined
            : currentState.loadingMessageParams,
        };
        if (result.citationsChanged) {
          patch.citations = result.citations;
        }
        enqueuePatch(patch);
      }
    }

    // Flush so we don't drop the last text chunk.
    if (pendingPatch) {
      flush();
    }
    if (pendingFrame !== 0 && canRAF) {
      (
        globalThis as unknown as {
          cancelAnimationFrame: (h: number) => void;
        }
      ).cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }

    // Finalize stream
    const finalContent = streamParser.finalize();
    return {
      finalContent,
      threadId: streamParser.getThreadId(),
      pendingTranscriptions: streamParser.getPendingTranscriptions(),
      fileCacheUpdates: streamParser.getFileCacheUpdates?.(),
      activeFilesTokensConsumed: streamParser.getActiveFilesTokensConsumed?.(),
      activeFilesDropped: streamParser.getActiveFilesDropped?.(),
      toolCalls: streamParser.getToolCallRecords?.(),
      consentRequests: streamParser.getConsentRequests?.(),
    };
  },

  finalizeMessage: async (
    assistantMessage: Message,
    conversation: Conversation,
    threadId?: string,
    pendingTranscriptions?: {
      filename: string;
      jobId: string;
      blobPath?: string;
      totalChunks?: number;
      jobType?: 'chunked' | 'batch';
    }[],
  ) => {
    const conversationStore = useConversationStore.getState();
    const { regeneratingIndex } = get();
    const hasPendingTranscription =
      pendingTranscriptions && pendingTranscriptions.length > 0;

    if (regeneratingIndex !== null) {
      // Adding a new version to an existing message group
      const version = messageToVersion(assistantMessage);
      conversationStore.addMessageVersion(
        conversation.id,
        regeneratingIndex,
        version,
      );
      // Clear regenerating index
      set({ regeneratingIndex: null });
    } else {
      // Creating a new assistant message group
      const newGroup = createMessageGroup(assistantMessage);
      const updates: Partial<Conversation> = {
        messages: [...conversation.messages, newGroup],
        ...(threadId ? { threadId } : {}),
      };

      // Auto-name conversation if still untitled (empty string or legacy "New Conversation")
      if (
        (conversation.name === '' ||
          conversation.name === 'New Conversation') &&
        conversation.messages.length > 0
      ) {
        // Set immediate fallback title (sync) for instant feedback
        const firstMessage = entryToDisplayMessage(conversation.messages[0]);
        const fallbackName = get().generateConversationName(firstMessage);
        if (fallbackName) {
          updates.name = fallbackName;
        }

        // Defer AI title generation if transcription is pending
        // The polling hook will generate the title after transcription completes
        if (hasPendingTranscription) {
          console.log(
            '[ChatStore] Deferring title generation until transcription completes',
          );
          // Use filename as temporary title if available
          if (pendingTranscriptions[0]?.filename) {
            updates.name = pendingTranscriptions[0].filename;
          }
        } else {
          // Generate AI title async (fire and forget - updates when ready)
          const conversationId = conversation.id;
          const modelId = conversation.model.id;
          const messageGroups = [
            ...conversation.messages,
            createMessageGroup(assistantMessage),
          ];

          generateConversationTitle(messageGroups, modelId)
            .then((result) => {
              if (result?.title) {
                conversationStore.updateConversation(conversationId, {
                  name: result.title,
                });
              }
            })
            .catch((error) => {
              console.error('[ChatStore] Failed to generate AI title:', error);
            });
        }
      }

      conversationStore.updateConversation(conversation.id, updates);
    }
  },

  generateConversationName: (firstUserMessage: Message): string | null => {
    if (!firstUserMessage || firstUserMessage.role !== 'user') return null;

    const analyzer = new MessageContentAnalyzer(firstUserMessage);

    // Try to get filename from first file
    const files = analyzer.extractFileUrls();
    if (files.length > 0 && files[0].originalFilename) {
      return files[0].originalFilename;
    }

    // Fallback to text content (first 50 chars)
    const text = analyzer.extractText();
    if (text) {
      const content = text.split('\n')[0];
      return content.length > 50 ? content.substring(0, 50) + '...' : content;
    }

    return null;
  },

  clearStreamingState: () => {
    // `pendingOAuthResume` outlives this — the next OAuthConsentCard reads
    // it to render "sign-in incomplete" framing, then clears its own entry.
    set({
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      loadingMessage: null,
      loadingMessageParams: undefined,
      streamingConsentRequests: [],
      streamingToolCalls: [],
      abortController: null,
      stopRequested: false,
    });
  },

  handleSendError: (
    error: unknown,
    conversation?: Conversation,
    searchMode?: SearchMode,
  ) => {
    // Check if this is an abort error (user clicked stop)
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('[chatStore] Request was aborted by user');
      set({
        isStreaming: false,
        streamingContent: '',
        streamingConversationId: null,
        loadingMessage: null,
        abortController: null,
        stopRequested: false,
        error: null, // Don't show error for user-initiated stops
        isRetrying: false,
      });
      return;
    }

    // Check if we should attempt auto-retry with a fallback model.
    // Client errors (4xx) other than 429 would fail identically on any
    // model — bad payload, auth, corrupted history — so don't fall back.
    // 5xx, rate limits, and network errors are worth trying another model.
    //
    // Curated/custom agents are NEVER retried — the agent's tools,
    // instructions, and connections are the whole point of choosing it.
    // Standard models that happen to be invoked via Foundry's agent service
    // (e.g. GPT-5.2 with `isAgent: true`) DO retry — that flag is just a
    // deployment-mechanism marker, not "user picked a curated agent".
    const { isRetrying } = get();
    const isNonRetryableClientError =
      error instanceof ApiError &&
      error.isClientError() &&
      error.status !== 429;
    const modelId = conversation?.model?.id ?? '';
    const isCuratedAgent =
      conversation?.model?.isOrganizationAgent ||
      conversation?.model?.isCustomAgent ||
      modelId.startsWith('org-') ||
      modelId.startsWith('foundry-') ||
      modelId.startsWith('custom-');
    const nextFallbackModel = conversation
      ? getFallbackModel([conversation.model.id])
      : null;

    if (
      !isNonRetryableClientError &&
      !isCuratedAgent &&
      !isRetrying &&
      conversation &&
      nextFallbackModel
    ) {
      console.log(
        '[chatStore] Attempting auto-retry with fallback model:',
        nextFallbackModel.id,
      );
      // Store failed conversation for regenerate button
      set({
        failedConversation: conversation,
        failedSearchMode: searchMode,
      });
      get().retryWithFallbackModel(conversation, searchMode);
      return;
    }

    // Capture partial stream state before we wipe it — tool calls and
    // consent prompts that completed before the failure should still be
    // shown to the user so the failure has context.
    const {
      streamingToolCalls: partialToolCalls,
      streamingConsentRequests: partialConsentRequests,
      streamingContent: partialContent,
    } = get();
    const hasPartialState =
      partialToolCalls.length > 0 ||
      partialConsentRequests.length > 0 ||
      partialContent.trim().length > 0;

    // Extract user-friendly error message
    let errorMessage = 'Failed to send message';
    let errorIsRecoverable = true;
    if (error instanceof ApiError) {
      errorMessage = error.getUserMessage();
      errorIsRecoverable = !error.isCorruptedHistoryError();
      console.error('API Error:', {
        status: error.status,
        message: error.message,
      });
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    // Reword opaque "network error"-style messages when we have partial
    // state — most useful for mid-stream agent failures (Foundry tool
    // timeouts, upstream connectors going down). The card below carries the
    // tool details.
    if (hasPartialState && /network error|fetch failed/i.test(errorMessage)) {
      errorMessage =
        'The agent stopped responding before finishing. Some tool calls may have completed — see the partial result.';
    }

    // Persist the partial assistant message so the tool summary survives
    // the failure, instead of vanishing with the streaming slices.
    if (hasPartialState && conversation) {
      const partialMessage: Message = {
        role: 'assistant',
        content: partialContent,
        messageType: MessageType.TEXT,
        error: true,
        toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
        consentRequests:
          partialConsentRequests.length > 0
            ? (partialConsentRequests as Message['consentRequests'])
            : undefined,
      };
      void get().finalizeMessage(partialMessage, conversation);
    }

    // Show error and store conversation for regenerate
    set({
      error: errorMessage,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      loadingMessage: null,
      streamingToolCalls: [],
      streamingConsentRequests: [],
      abortController: null,
      stopRequested: false,
      isRetrying: false,
      failedConversation: conversation || null,
      failedSearchMode: searchMode,
      errorIsRecoverable,
    });
  },

  retryWithFallbackModel: async (
    conversation: Conversation,
    searchMode?: SearchMode,
    attemptedModelIds: string[] = [conversation.model.id],
  ) => {
    const fallbackModel = getFallbackModel(attemptedModelIds);
    if (!fallbackModel) {
      console.error(
        '[chatStore] Fallback chain exhausted, attempted:',
        attemptedModelIds,
      );
      set({
        error: 'Failed to send message. Please try again.',
        isStreaming: false,
        isRetrying: false,
      });
      return;
    }

    // Show toast notification
    const toastId = toast.loading(`Retrying with ${fallbackModel.name}...`);

    // Store original model for the switch prompt
    const originalModelId = conversation.model.id;

    // Create conversation with fallback model
    const retryConversation: Conversation = {
      ...conversation,
      model: fallbackModel,
    };

    set({
      isRetrying: true,
      originalModelId,
      error: null,
    });

    let showLoadingTimeout: NodeJS.Timeout | null = null;

    try {
      // Use analyzer to determine loading message key (for translation in UI)
      // Flatten messages to find user messages
      const flatMessages = flattenEntriesForAPI(conversation.messages);
      const lastUserMessage = flatMessages
        .filter((m) => m.role === 'user')
        .pop();

      if (!lastUserMessage) {
        throw new Error('No user message found');
      }

      const analyzer = new MessageContentAnalyzer(lastUserMessage);
      const loadingMessage = analyzer.getLoadingMessageKey();

      // Initialize streaming state
      get().initializeStreamingState(retryConversation.id, loadingMessage);

      // Schedule loading message display
      showLoadingTimeout = get().scheduleLoadingMessage(loadingMessage);

      // Send request with fallback model
      const stream = await get().sendChatRequest(retryConversation, searchMode);

      // Process the stream
      const streamParser = new StreamParser();
      const {
        finalContent,
        threadId,
        pendingTranscriptions,
        fileCacheUpdates,
        activeFilesTokensConsumed,
        activeFilesDropped,
        toolCalls,
        consentRequests,
      } = await get().processStream(stream, streamParser, showLoadingTimeout);

      // Create assistant message
      const assistantMessage = buildAssistantMessage(
        streamParser,
        finalContent,
        toolCalls,
        consentRequests,
      );

      // Surface dropped files (see send path for context).
      get().setLastTurnDroppedActiveFileIds(
        conversation.id,
        activeFilesDropped ?? [],
      );

      // Handle pending transcriptions (async batch jobs for large files)
      if (pendingTranscriptions && pendingTranscriptions.length > 0) {
        const messageIndex = conversation.messages.length;
        const pending = pendingTranscriptions[0];
        get().setConversationTranscriptionPending({
          conversationId: conversation.id,
          jobId: pending.jobId,
          messageIndex,
          filename: pending.filename,
          blobPath: pending.blobPath,
        });
      }

      // Finalize: update conversation with original model (not fallback)
      // The message was generated with fallback but we keep the conversation model unchanged
      await get().finalizeMessage(
        assistantMessage,
        conversation,
        threadId,
        pendingTranscriptions,
      );

      const conversationStore = useConversationStore.getState();
      if (fileCacheUpdates && fileCacheUpdates.length > 0) {
        for (const u of fileCacheUpdates) {
          if (u?.fileId && u?.processedContent) {
            conversationStore.updateFileProcessedContent(
              conversation.id,
              u.fileId,
              u.processedContent as any,
            );
          }
        }
      }

      // Auto-activate transcript as active file (sync transcription path)
      const transcript = streamParser.getTranscript();
      const isSyncTranscript =
        transcript?.transcript &&
        !transcript.transcript.startsWith('[Transcription in progress');

      if (isSyncTranscript) {
        const tokenEstimate = Math.ceil(transcript.transcript.length / 4);
        const activeFile: ActiveFile = {
          id: `transcript-sync-${Date.now()}`,
          url: `transcript://sync/${encodeURIComponent(transcript.filename)}`,
          originalFilename: `${transcript.filename}.transcript.txt`,
          addedAt: new Date().toISOString(),
          sourceMessageId: '',
          status: 'ready',
          pinned: false,
          processedContent: {
            type: 'transcript',
            content: transcript.transcript,
            tokenEstimate,
            processedAt: new Date().toISOString(),
          },
        };
        conversationStore.activateFile(conversation.id, activeFile);
      }

      // Deduct active files session quota
      if (activeFilesTokensConsumed && activeFilesTokensConsumed > 0) {
        conversationStore.deductActiveFilesTokens(
          conversation.id,
          activeFilesTokensConsumed,
        );
      }

      // Clear streaming state and show success
      get().clearStreamingState();

      // Dismiss loading toast and show success
      toast.success(`Request completed with ${fallbackModel.name}`, {
        id: toastId,
      });

      // Show model switch prompt - store conversation ID for model switching
      set({
        isRetrying: false,
        retryWithFallback: true,
        successfulFallbackModelId: fallbackModel.id,
        showModelSwitchPrompt: true,
        successfulRetryConversationId: conversation.id,
        failedConversation: null,
        failedSearchMode: undefined,
      });

      // Clean up timeout
      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }
    } catch (retryError) {
      console.error('[chatStore] Retry with fallback also failed:', retryError);

      // Clean up timeout
      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }

      // User clicked stop mid-retry — don't continue the chain or show errors
      if (retryError instanceof Error && retryError.name === 'AbortError') {
        toast.dismiss(toastId);
        get().clearStreamingState();
        set({ isRetrying: false, error: null });
        return;
      }

      // Try the next model in the fallback chain, unless this failure would
      // hit every model the same way (4xx other than rate limiting)
      const isNonRetryableClientError =
        retryError instanceof ApiError &&
        retryError.isClientError() &&
        retryError.status !== 429;
      const nextAttemptedIds = [...attemptedModelIds, fallbackModel.id];

      if (!isNonRetryableClientError && getFallbackModel(nextAttemptedIds)) {
        toast.dismiss(toastId);
        return get().retryWithFallbackModel(
          conversation,
          searchMode,
          nextAttemptedIds,
        );
      }

      // Dismiss loading toast
      toast.error(`Retry with ${fallbackModel.name} also failed`, {
        id: toastId,
      });

      // Extract error message
      let errorMessage = 'Failed to send message';
      if (retryError instanceof ApiError) {
        errorMessage = retryError.getUserMessage();
      } else if (retryError instanceof Error) {
        errorMessage = retryError.message;
      }

      // Show error with regenerate option
      set({
        error: errorMessage,
        isStreaming: false,
        streamingContent: '',
        streamingConversationId: null,
        loadingMessage: null,
        abortController: null,
        stopRequested: false,
        isRetrying: false,
        retryWithFallback: false,
        originalModelId: null,
      });
    }
  },

  retryFailedRequest: async () => {
    const { failedConversation, failedSearchMode } = get();
    if (!failedConversation) return;

    // Walk backwards so we skip any partial assistant entry left from the
    // failed turn.
    const flat = flattenEntriesForAPI(failedConversation.messages);
    let userMessage: Message | undefined;
    for (let i = flat.length - 1; i >= 0; i--) {
      if (flat[i].role === 'user') {
        userMessage = flat[i];
        break;
      }
    }
    if (!userMessage) return;

    set({
      error: null,
      failedConversation: null,
      failedSearchMode: undefined,
      errorIsRecoverable: true,
    });

    await get().sendMessage(userMessage, failedConversation, failedSearchMode);
  },

  dismissModelSwitchPrompt: () => {
    set({
      showModelSwitchPrompt: false,
      originalModelId: null,
      successfulFallbackModelId: null,
      retryWithFallback: false,
      successfulRetryConversationId: null,
    });
  },

  acceptModelSwitch: (alwaysSwitch?: boolean) => {
    const settings = useSettingsStore.getState();
    const conversationStore = useConversationStore.getState();
    const { successfulRetryConversationId, successfulFallbackModelId } = get();

    // Switch to the chain model that actually produced the successful retry
    const switchedModelId = (successfulFallbackModelId ||
      fallbackModelID) as OpenAIModelID;

    // Set fallback as default model for new conversations
    settings.setDefaultModelId(switchedModelId);

    // If alwaysSwitch, persist auto-switch preference for future failures
    if (alwaysSwitch) {
      settings.setAutoSwitchOnFailure(true);
    }

    // Update current conversation model using the stored ID
    if (successfulRetryConversationId) {
      const fallbackModel = OpenAIModels[switchedModelId];
      if (fallbackModel) {
        conversationStore.updateConversation(successfulRetryConversationId, {
          model: fallbackModel,
        });
      }
    }

    set({
      showModelSwitchPrompt: false,
      originalModelId: null,
      successfulFallbackModelId: null,
      retryWithFallback: false,
      successfulRetryConversationId: null,
    });
  },

  submitApproval: async (
    approvalRequestId,
    approve,
    conversation,
    sourceMessageIndex,
    source,
  ) => {
    // Atomic check-and-lock. An approval submit starts a brand-new stream
    // (initializeStreamingState + sendChatRequest), so only ONE may run at a
    // time: if a chat is already streaming, or another approval is mid-flight,
    // launching a second would clobber the shared abortController and double
    // up finalizeMessage. Multiple idle cards can fire together (shared keydown
    // listener, or several auto-approve effects in one commit) and each reads
    // pre-lock state, so the guard must be a single synchronous set() that both
    // tests and claims the lock. Callers that lose the race are simply ignored;
    // the user (or the auto-approve effect) can submit the next one once this
    // stream settles.
    let acquired = false;
    set((state) => {
      if (
        state.isStreaming ||
        state.submittingApprovals.size > 0 ||
        state.submittingApprovals.has(approvalRequestId) ||
        state.submittedApprovals.has(approvalRequestId)
      ) {
        return state;
      }
      acquired = true;
      const next = new Set(state.submittingApprovals);
      next.add(approvalRequestId);
      return { submittingApprovals: next };
    });
    if (!acquired) {
      return;
    }

    // Promote submitting → submitted, drop any failed-guard entry, persist the
    // outcome on the source message, and tear down streaming state. Shared by
    // the success path and the "duplicate (already recorded)" path.
    const finalizeSubmitted = () => {
      set((state) => {
        const submitted = new Map(state.submittedApprovals);
        submitted.set(approvalRequestId, approve);
        const submitting = new Set(state.submittingApprovals);
        submitting.delete(approvalRequestId);
        return {
          submittedApprovals: submitted,
          submittingApprovals: submitting,
          failedApprovals: setWithout(state.failedApprovals, approvalRequestId),
        };
      });
      if (sourceMessageIndex !== undefined) {
        useConversationStore
          .getState()
          .recordApprovalOutcome(
            conversation.id,
            sourceMessageIndex,
            approvalRequestId,
            approve,
            source,
          );
      }
      get().clearStreamingState();
    };

    let showLoadingTimeout: NodeJS.Timeout | null = null;

    try {
      const loadingMessage = approve
        ? 'chat.consent.submittingApproval'
        : 'chat.consent.submittingDenial';

      get().initializeStreamingState(conversation.id, loadingMessage);
      showLoadingTimeout = get().scheduleLoadingMessage(loadingMessage);

      const stream = await get().sendChatRequest(conversation, undefined, [
        { approval_request_id: approvalRequestId, approve },
      ]);

      const streamParser = new StreamParser();
      const {
        finalContent,
        threadId,
        pendingTranscriptions,
        toolCalls,
        consentRequests,
      } = await get().processStream(stream, streamParser, showLoadingTimeout);

      const assistantMessage = buildAssistantMessage(
        streamParser,
        finalContent,
        toolCalls,
        consentRequests,
      );

      await get().finalizeMessage(
        assistantMessage,
        conversation,
        threadId,
        pendingTranscriptions,
      );

      // Promote submitting → submitted and persist (a successful retry also
      // clears any prior `failedApprovals` entry so auto-approve unblocks).
      finalizeSubmitted();

      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }
    } catch (error) {
      console.error('submitApproval error:', error);

      if (showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
      }

      // Foundry says the approval is already recorded. From our side that's
      // effectively a success — promote to "submitted" and persist, so the
      // auto-approve effect doesn't re-fire in a loop on the same id.
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isDuplicate = /Duplicate MCP approval response/i.test(errorMessage);

      if (isDuplicate) {
        finalizeSubmitted();
        return;
      }

      // Real failure (network, abort, server error): record it so the
      // auto-approve effect doesn't keep retrying the same id, and clear
      // the submitting marker so the user can manually retry from the card.
      set((state) => {
        const submitting = new Set(state.submittingApprovals);
        submitting.delete(approvalRequestId);
        const failed = new Set(state.failedApprovals);
        failed.add(approvalRequestId);
        return { submittingApprovals: submitting, failedApprovals: failed };
      });

      get().handleSendError(error, conversation);
    }
  },
}));
