'use client';

import { MessageContentAnalyzer } from '@/lib/utils/chat/messageContentAnalyzer';
import { StreamParser } from '@/lib/utils/chat/streamParser';

import { AgentType } from '@/types/agent';
import { Conversation, Message, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
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

  // Actions
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
  ) => Promise<{ finalContent: string; threadId?: string }>;
  finalizeMessage: (
    assistantMessage: Message,
    conversation: Conversation,
    threadId?: string,
  ) => Promise<void>;
  generateConversationName: (firstUserMessage: Message) => string | null;
  clearStreamingState: () => void;
  handleSendError: (error: unknown) => void;
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

  // Actions
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

  requestStop: () => set({ stopRequested: true }),

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
    }),

  sendMessage: async (message, conversation, searchMode) => {
    console.log('[chatStore.sendMessage] Message toneId:', message.toneId);
    console.log(
      '[chatStore.sendMessage] All messages:',
      conversation.messages.map((m) => ({ role: m.role, toneId: m.toneId })),
    );

    let showLoadingTimeout: NodeJS.Timeout | null = null;

    try {
      // Use analyzer to determine loading message
      const analyzer = new MessageContentAnalyzer(message);
      const loadingMessage = analyzer.getLoadingMessage();

      // Initialize streaming state
      get().initializeStreamingState(conversation.id, loadingMessage);

      // Schedule loading message display (only if response is slow)
      showLoadingTimeout = get().scheduleLoadingMessage(loadingMessage);

      // Prepare and send the API request
      const stream = await get().sendChatRequest(conversation, searchMode);

      // Process the stream
      const streamParser = new StreamParser();
      const { finalContent, threadId } = await get().processStream(
        stream,
        streamParser,
        showLoadingTimeout,
      );

      // Create assistant message
      const assistantMessage = streamParser.toMessage(finalContent);

      // Finalize: update conversation, auto-name if needed
      await get().finalizeMessage(assistantMessage, conversation, threadId);

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

      get().handleSendError(error);
    }
  },

  // Helper methods for sendMessage

  initializeStreamingState: (
    conversationId: string,
    loadingMessage: string,
  ) => {
    set({
      isStreaming: true,
      streamingContent: '',
      streamingConversationId: conversationId,
      error: null,
      citations: [],
      loadingMessage: null, // Start with null, will be set after delay
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

    // Merge conversation model with latest configuration
    const latestModelConfig =
      OpenAIModels[conversation.model.id as OpenAIModelID];
    const modelToSend = latestModelConfig
      ? { ...conversation.model, ...latestModelConfig }
      : conversation.model;

    // Get the toneId from the latest user message and look up the full tone object
    const latestUserMessage = conversation.messages
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

    return await chatService.chat(modelToSend, conversation.messages, {
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
    });
  },

  processStream: async (
    stream: ReadableStream<Uint8Array>,
    streamParser: StreamParser,
    showLoadingTimeout: NodeJS.Timeout | null,
  ): Promise<{ finalContent: string; threadId?: string }> => {
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
    };
  },

  finalizeMessage: async (
    assistantMessage: Message,
    conversation: Conversation,
    threadId?: string,
  ) => {
    const conversationStore = useConversationStore.getState();
    const updates: Partial<Conversation> = {
      messages: [...conversation.messages, assistantMessage],
      ...(threadId ? { threadId } : {}),
    };

    // Auto-name conversation if still "New Conversation"
    if (
      conversation.name === 'New Conversation' &&
      conversation.messages.length > 0
    ) {
      const newName = get().generateConversationName(conversation.messages[0]);
      if (newName) {
        updates.name = newName;
      }
    }

    conversationStore.updateConversation(conversation.id, updates);
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
    });
  },

  handleSendError: (error: unknown) => {
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

    set({
      error: errorMessage,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      loadingMessage: null,
    });
  },
}));
