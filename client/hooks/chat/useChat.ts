import { useChatStore } from '@/client/stores/chatStore';

/**
 * Hook that manages active chat state (no persistence needed - ephemeral)
 */
export function useChat() {
  const store = useChatStore();

  return {
    // State
    currentMessage: store.currentMessage,
    isStreaming: store.isStreaming,
    streamingContent: store.streamingContent,
    streamingConversationId: store.streamingConversationId,
    citations: store.citations,
    error: store.error,
    stopRequested: store.stopRequested,
    loadingMessage: store.loadingMessage,

    // Retry-related state
    isRetrying: store.isRetrying,
    retryWithFallback: store.retryWithFallback,
    originalModelId: store.originalModelId,
    showModelSwitchPrompt: store.showModelSwitchPrompt,
    failedConversation: store.failedConversation,

    // Actions
    setCurrentMessage: store.setCurrentMessage,
    setIsStreaming: store.setIsStreaming,
    setStreamingContent: store.setStreamingContent,
    appendStreamingContent: store.appendStreamingContent,
    setCitations: store.setCitations,
    setError: store.setError,
    clearError: store.clearError,
    requestStop: store.requestStop,
    resetStop: store.resetStop,
    resetChat: store.resetChat,
    setLoadingMessage: store.setLoadingMessage,
    sendMessage: store.sendMessage,

    // Retry-related actions
    dismissModelSwitchPrompt: store.dismissModelSwitchPrompt,
    acceptModelSwitch: store.acceptModelSwitch,
  };
}
