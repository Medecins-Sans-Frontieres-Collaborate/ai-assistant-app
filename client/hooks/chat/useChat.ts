import { useShallow } from 'zustand/react/shallow';

import { useChatStore } from '@/client/stores/chatStore';

/**
 * Hook that manages active chat state (no persistence needed - ephemeral).
 *
 * ## Why useShallow?
 *
 * Without useShallow, selecting multiple values as an object creates a new reference
 * on every store update, causing unnecessary re-renders even when values haven't changed.
 * This is critical for chat state because:
 *
 * 1. **High-frequency updates**: During streaming, `streamingContent` updates rapidly
 * 2. **Broad consumption**: Many components use this hook
 * 3. **Subset usage**: Components typically only use a few values from the returned object
 *
 * useShallow performs shallow equality comparison, only triggering re-renders when
 * actual values change. This follows the same pattern as useConversations.ts.
 *
 * @see https://zustand.docs.pmnd.rs/guides/prevent-rerenders-with-use-shallow
 */
export function useChat() {
  const state = useChatStore(
    useShallow((s) => ({
      currentMessage: s.currentMessage,
      isStreaming: s.isStreaming,
      streamingContent: s.streamingContent,
      streamingConversationId: s.streamingConversationId,
      citations: s.citations,
      error: s.error,
      stopRequested: s.stopRequested,
      loadingMessage: s.loadingMessage,
      isRetrying: s.isRetrying,
      retryWithFallback: s.retryWithFallback,
      originalModelId: s.originalModelId,
      showModelSwitchPrompt: s.showModelSwitchPrompt,
      failedConversation: s.failedConversation,
    })),
  );

  const actions = useChatStore(
    useShallow((s) => ({
      setCurrentMessage: s.setCurrentMessage,
      setIsStreaming: s.setIsStreaming,
      setStreamingContent: s.setStreamingContent,
      appendStreamingContent: s.appendStreamingContent,
      setCitations: s.setCitations,
      setError: s.setError,
      clearError: s.clearError,
      requestStop: s.requestStop,
      resetStop: s.resetStop,
      resetChat: s.resetChat,
      setLoadingMessage: s.setLoadingMessage,
      sendMessage: s.sendMessage,
      dismissModelSwitchPrompt: s.dismissModelSwitchPrompt,
      acceptModelSwitch: s.acceptModelSwitch,
    })),
  );

  return { ...state, ...actions };
}
