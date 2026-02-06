'use client';

import toast from 'react-hot-toast';

import { generateConversationTitle } from '@/client/services/titleService';

import { MessageContentAnalyzer } from '@/lib/utils/shared/chat/messageContentAnalyzer';
import {
  createMessageGroup,
  entryToDisplayMessage,
  flattenEntriesForAPI,
  messageToVersion,
} from '@/lib/utils/shared/chat/messageVersioning';
import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { AgentType } from '@/types/agent';
import { Conversation, Message, MessageType } from '@/types/chat';
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

import { ApiError, chatService } from '@/client/services';
import { create } from 'zustand';

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
  abortController: AbortController | null;

  // Retry-related state
  isRetrying: boolean;
  retryWithFallback: boolean;
  originalModelId: string | null;
  showModelSwitchPrompt: boolean;
  failedConversation: Conversation | null;
  failedSearchMode: SearchMode | undefined;
  successfulRetryConversationId: string | null;

  // Regeneration state for message versioning
  regeneratingIndex: number | null;

  // Actions
  setRegeneratingIndex: (index: number | null) => void;
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
  setLoadingMessage: (message: string | null) => void;
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
  ) => Promise<ReadableStream<Uint8Array>>;
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
  ) => Promise<void>;
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
    progress?: {
      completed: number;
      total: number;
    };
  } | null;
  setConversationTranscriptionPending: (
    info: {
      conversationId: string;
      jobId: string;
      messageIndex: number;
      filename: string;
      blobPath?: string;
    } | null,
  ) => void;
  updateTranscriptionProgress: (completed: number, total: number) => void;
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
  abortController: null,

  // Retry-related initial state
  isRetrying: false,
  retryWithFallback: false,
  originalModelId: null,
  showModelSwitchPrompt: false,
  failedConversation: null,
  failedSearchMode: undefined,
  successfulRetryConversationId: null,

  // Regeneration initial state
  regeneratingIndex: null,

  // Pending transcription initial state
  pendingConversationTranscription: null,

  // Actions
  setRegeneratingIndex: (index) => set({ regeneratingIndex: index }),

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

  setLoadingMessage: (message) => set({ loadingMessage: message }),

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
      abortController: null,
      // Reset retry state
      isRetrying: false,
      retryWithFallback: false,
      originalModelId: null,
      showModelSwitchPrompt: false,
      failedConversation: null,
      failedSearchMode: undefined,
      successfulRetryConversationId: null,
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
      const { finalContent, threadId, pendingTranscriptions } =
        await get().processStream(stream, streamParser, showLoadingTimeout);

      // Create assistant message
      const assistantMessage = streamParser.toMessage(finalContent);

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
      stopRequested: false,
      abortController,
    });
  },

  scheduleLoadingMessage: (loadingMessage: string): NodeJS.Timeout => {
    const loadingDelay = 400; // milliseconds
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
      // Try settings default, then global fallback
      const fallbackId = settings.defaultModelId || fallbackModelID;
      latestModelConfig = OpenAIModels[fallbackId];

      if (!latestModelConfig) {
        throw new Error(
          `No valid model available. Requested: ${conversation.model.id}, Fallback: ${fallbackId}`,
        );
      }
    }

    // For organization/custom agents, use the conversation model directly (it already has full config)
    // For base models, merge with latest config from OpenAIModels
    const modelToSend =
      isOrganizationAgent || isCustomAgent
        ? conversation.model
        : { ...conversation.model, ...latestModelConfig };

    // Flatten messages for API call
    const messagesForAPI = flattenEntriesForAPI(conversation.messages);

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

    return await chatService.chat(modelToSend, messagesForAPI, {
      prompt: settings.systemPrompt,
      temperature: settings.temperature,
      stream: modelSupportsStreaming,
      botId: conversation.bot,
      threadId: conversation.threadId,
      reasoningEffort:
        conversation.reasoningEffort || modelToSend.reasoningEffort,
      verbosity: conversation.verbosity || modelToSend.verbosity,
      searchMode,
      tone, // Pass the full tone object
      signal: abortController?.signal, // Pass abort signal
      streamingSpeed: settings.streamingSpeed, // Pass streaming speed configuration
      includeUserInfoInPrompt: settings.includeUserInfoInPrompt,
      preferredName: settings.preferredName,
      userContext: settings.userContext,
      displayNamePreference: settings.displayNamePreference,
      customDisplayName: settings.customDisplayName,
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
  }> => {
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Process chunk
      const result = streamParser.processChunk(value, { stream: true });

      // Update action message if found (e.g., "Searching the web...")
      if (result.action && !result.hasReceivedContent) {
        set({ loadingMessage: result.action });
      }

      // Clear loading timeout once content arrives
      if (result.hasReceivedContent && showLoadingTimeout) {
        clearTimeout(showLoadingTimeout);
        showLoadingTimeout = null;
      }

      // Only update state if something changed
      const currentState = get();
      const shouldClearLoading =
        result.hasReceivedContent && currentState.loadingMessage !== null;

      if (
        result.contentChanged ||
        result.citationsChanged ||
        shouldClearLoading
      ) {
        const update: {
          streamingContent: string;
          citations?: Citation[];
          loadingMessage: string | null;
        } = {
          streamingContent: result.displayText,
          loadingMessage: result.hasReceivedContent
            ? null
            : currentState.loadingMessage,
        };

        if (result.citationsChanged) {
          update.citations = result.citations;
        }

        set(update);
      }
    }

    // Finalize stream
    const finalContent = streamParser.finalize();
    return {
      finalContent,
      threadId: streamParser.getThreadId(),
      pendingTranscriptions: streamParser.getPendingTranscriptions(),
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
    set({
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      loadingMessage: null,
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

    // Check if we should attempt auto-retry with fallback model
    const { isRetrying } = get();
    const isAuthError = error instanceof ApiError && error.isAuthError();
    const isCustomAgent = conversation?.model?.id?.startsWith('custom-');
    const isAlreadyOnFallback = conversation?.model?.id === fallbackModelID;
    const canRetry =
      !isAuthError &&
      !isCustomAgent &&
      !isAlreadyOnFallback &&
      !isRetrying &&
      conversation;

    if (canRetry) {
      console.log(
        '[chatStore] Attempting auto-retry with fallback model:',
        fallbackModelID,
      );
      // Store failed conversation for regenerate button
      set({
        failedConversation: conversation,
        failedSearchMode: searchMode,
      });
      get().retryWithFallbackModel(conversation, searchMode);
      return;
    }

    // Extract user-friendly error message
    let errorMessage = 'Failed to send message';
    if (error instanceof ApiError) {
      errorMessage = error.getUserMessage();
      console.error('API Error:', {
        status: error.status,
        message: error.message,
      });
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    // Show error and store conversation for regenerate
    set({
      error: errorMessage,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      loadingMessage: null,
      abortController: null,
      stopRequested: false,
      isRetrying: false,
      failedConversation: conversation || null,
      failedSearchMode: searchMode,
    });
  },

  retryWithFallbackModel: async (
    conversation: Conversation,
    searchMode?: SearchMode,
  ) => {
    const fallbackModel = OpenAIModels[fallbackModelID];
    if (!fallbackModel) {
      console.error('[chatStore] Fallback model not found:', fallbackModelID);
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
      const { finalContent, threadId, pendingTranscriptions } =
        await get().processStream(stream, streamParser, showLoadingTimeout);

      // Create assistant message
      const assistantMessage = streamParser.toMessage(finalContent);

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

  dismissModelSwitchPrompt: () => {
    set({
      showModelSwitchPrompt: false,
      originalModelId: null,
      retryWithFallback: false,
      successfulRetryConversationId: null,
    });
  },

  acceptModelSwitch: (alwaysSwitch?: boolean) => {
    const settings = useSettingsStore.getState();
    const conversationStore = useConversationStore.getState();
    const { successfulRetryConversationId } = get();

    // Set fallback as default model for new conversations
    settings.setDefaultModelId(fallbackModelID);

    // If alwaysSwitch, persist auto-switch preference for future failures
    if (alwaysSwitch) {
      settings.setAutoSwitchOnFailure(true);
    }

    // Update current conversation model using the stored ID
    if (successfulRetryConversationId) {
      const fallbackModel = OpenAIModels[fallbackModelID];
      if (fallbackModel) {
        conversationStore.updateConversation(successfulRetryConversationId, {
          model: fallbackModel,
        });
      }
    }

    set({
      showModelSwitchPrompt: false,
      originalModelId: null,
      retryWithFallback: false,
      successfulRetryConversationId: null,
    });
  },
}));
