'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useChat } from '@/client/hooks/chat/useChat';
import { useChatActions } from '@/client/hooks/chat/useChatActions';
import { useChatScrolling } from '@/client/hooks/chat/useChatScrolling';
import { useConversationInitialization } from '@/client/hooks/chat/useConversationInitialization';
import { usePromptSaving } from '@/client/hooks/chat/usePromptSaving';
import { useSmoothStreaming } from '@/client/hooks/chat/useSmoothStreaming';
import { useClearConversation } from '@/client/hooks/conversation/useClearConversation';
import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useAutoDismissError } from '@/client/hooks/ui/useAutoDismissError';
import { useModalState } from '@/client/hooks/ui/useModalSync';
import { useUI } from '@/client/hooks/ui/useUI';

import { getUserDisplayName } from '@/lib/utils/app/user/displayName';

import { OpenAIModelID, OpenAIModels, fallbackModelID } from '@/types/openai';

import { PromptModal } from '@/components/Prompts/PromptModal';

import { ChatError } from './ChatError';
import { ChatInput } from './ChatInput';
import { ChatMessages } from './ChatMessages';
import { ChatTopbar } from './ChatTopbar';
import { EmptyState } from './EmptyState/EmptyState';
import { SuggestedPrompts } from './EmptyState/SuggestedPrompts';
import { LoadingScreen } from './LoadingScreen';
import { ModelSelect } from './ModelSelect';
import { ModelSwitchPrompt } from './ModelSwitchPrompt';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { getOrganizationAgentById } from '@/lib/organizationAgents';

const CodeArtifact = dynamic(
  () => import('@/components/CodeEditor/CodeArtifact'),
  {
    ssr: false,
  },
);

const DocumentArtifact = dynamic(
  () => import('@/components/DocumentEditor/DocumentArtifact'),
  {
    ssr: false,
  },
);

interface ChatProps {
  mobileModelSelectOpen?: boolean;
  onMobileModelSelectChange?: (open: boolean) => void;
}

/**
 * Main chat component
 */
export function Chat({
  mobileModelSelectOpen,
  onMobileModelSelectChange,
}: ChatProps = {}) {
  const t = useTranslations();
  const { data: session, status } = useSession();
  const {
    selectedConversation,
    updateConversation,
    conversations,
    addConversation,
    selectConversation,
    isLoaded,
  } = useConversations();
  const {
    isStreaming,
    streamingContent,
    streamingConversationId,
    error,
    sendMessage,
    citations,
    clearError,
    loadingMessage,
    isRetrying,
    showModelSwitchPrompt,
    originalModelId,
    dismissModelSwitchPrompt,
    acceptModelSwitch,
  } = useChat();

  const { isSettingsOpen, setIsSettingsOpen, showChatbar } = useUI();
  const {
    models,
    defaultModelId,
    systemPrompt,
    temperature,
    defaultSearchMode,
    displayNamePreference,
    customDisplayName,
    addPrompt,
    streamingSpeed,
  } = useSettings();

  const { content: smoothedContent, isDraining } = useSmoothStreaming({
    isStreaming,
    content: streamingContent ?? '',
    charsPerFrame: streamingSpeed.charsPerBatch,
    frameDelay: streamingSpeed.delayMs,
    enabled: isStreaming,
  });
  const {
    isArtifactOpen,
    editorMode,
    closeArtifact,
    setEditorMode,
    canSwitchToDocumentMode,
  } = useArtifactStore();

  // Split view state for code editor
  const [editorWidth, setEditorWidth] = useState(50); // Percentage
  const [isResizing, setIsResizing] = useState(false);

  // Transcription state (local to Chat component)
  const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stopConversationRef = useRef<boolean>(false);

  // Resizing handlers for split view
  const handleMouseDown = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      // Get the chat container element to calculate relative to it, not window
      const chatContainer = document.querySelector('.chat-split-container');
      if (!chatContainer) return;

      const rect = chatContainer.getBoundingClientRect();
      const containerWidth = rect.width;
      const mouseX = e.clientX - rect.left;

      // Calculate editor width as percentage of container
      const newEditorWidth = ((containerWidth - mouseX) / containerWidth) * 100;

      // Constrain between 20% and 80% for more flexibility
      const constrainedWidth = Math.max(20, Math.min(80, newEditorWidth));
      setEditorWidth(constrainedWidth);
    },
    [isResizing],
  );

  // Mouse event listeners for resizing
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', handleMouseMove as any);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', handleMouseMove as any);
        window.removeEventListener('mouseup', handleMouseUp);
      }
    };
  }, [handleMouseMove, handleMouseUp]);

  // Modal state
  const [isModelSelectOpen, setIsModelSelectOpen] = useModalState(
    mobileModelSelectOpen,
    false,
    onMobileModelSelectChange,
  );

  // Custom hooks for state management
  const {
    messagesEndRef,
    chatContainerRef,
    lastMessageRef,
    showScrollDownButton,
    handleScrollDown,
  } = useChatScrolling({
    selectedConversationId: selectedConversation?.id,
    messageCount: selectedConversation?.messages?.length || 0,
    isStreaming,
    streamingContent,
    isDraining,
  });

  const {
    handleEditMessage,
    handleSend,
    handleSelectPrompt,
    handleRegenerate,
  } = useChatActions({
    updateConversation,
    sendMessage,
  });

  const { clearConversation } = useClearConversation();

  // Version navigation callback for message versioning
  const handleNavigateVersion = useCallback(
    (messageIndex: number, direction: 'prev' | 'next') => {
      if (!selectedConversation) return;
      useConversationStore
        .getState()
        .navigateVersion(selectedConversation.id, messageIndex, direction);
    },
    [selectedConversation],
  );

  const {
    isSavePromptModalOpen,
    savePromptContent,
    savePromptName,
    savePromptDescription,
    handleOpenSavePromptModal,
    handleSavePrompt,
    handleCloseSavePromptModal,
  } = usePromptSaving({
    models,
    defaultModelId,
    addPrompt,
  });

  useConversationInitialization({
    isLoaded,
    models,
    conversations,
    selectedConversation,
    defaultModelId,
    systemPrompt: systemPrompt || '',
    temperature: temperature || 0.5,
    defaultSearchMode,
    addConversation,
    selectConversation,
  });

  // Close modal on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isModelSelectOpen) {
        setIsModelSelectOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // setIsModelSelectOpen is a stable setState function and doesn't need to be a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModelSelectOpen]);

  // Clear error when switching conversations
  useEffect(() => {
    clearError();
  }, [selectedConversation?.id, clearError]);

  // Only auto-dismiss errors that can't be regenerated (e.g., during retry)
  // When regenerate is available, let the user decide when to dismiss
  const canRegenerate = !!error && !isRetrying;
  useAutoDismissError(canRegenerate ? null : error, clearError, 10000);

  const messages = selectedConversation?.messages || [];
  const hasMessages =
    messages.length > 0 ||
    (isStreaming && streamingConversationId === selectedConversation?.id);

  // Memoize organization agent lookup to avoid recomputing on every render
  const orgAgentInfo = useMemo(() => {
    const modelId = selectedConversation?.model?.id;
    const orgAgentId =
      selectedConversation?.bot ||
      (modelId?.startsWith('org-') ? modelId.replace('org-', '') : undefined);
    const orgAgent = orgAgentId
      ? getOrganizationAgentById(orgAgentId)
      : undefined;
    const isOrgAgent =
      !!orgAgent || selectedConversation?.model?.isOrganizationAgent;
    return { orgAgent, isOrgAgent };
  }, [
    selectedConversation?.bot,
    selectedConversation?.model?.id,
    selectedConversation?.model?.isOrganizationAgent,
  ]);

  // Show loading screen until session and data are fully loaded
  // This prevents UI flickering during initialization
  if (status === 'loading' || !isLoaded || models.length === 0) {
    return <LoadingScreen />;
  }

  return (
    <div className="chat-split-container relative flex h-full w-full overflow-hidden bg-white dark:bg-[#212121]">
      {/* Main chat area */}
      <div
        className="flex flex-col h-full overflow-hidden min-w-0"
        style={{
          width: isArtifactOpen ? `${100 - editorWidth}%` : '100%',
          minWidth: isArtifactOpen ? '20%' : undefined,
          maxWidth: isArtifactOpen ? '80%' : undefined,
        }}
      >
        {/* Header - Hidden on mobile, shown on desktop */}
        <div className="hidden md:block">
          <ChatTopbar
            botInfo={null}
            selectedModelName={
              selectedConversation?.model?.name ||
              models.find((m) => m.id === defaultModelId)?.name ||
              'GPT-4o'
            }
            selectedModelProvider={
              OpenAIModels[selectedConversation?.model?.id as OpenAIModelID]
                ?.provider ||
              models.find((m) => m.id === defaultModelId)?.provider
            }
            selectedModelId={selectedConversation?.model?.id}
            isCustomAgent={selectedConversation?.model?.isCustomAgent}
            isOrganizationAgent={orgAgentInfo.isOrgAgent}
            organizationAgentIcon={orgAgentInfo.orgAgent?.icon}
            organizationAgentColor={orgAgentInfo.orgAgent?.color}
            showSettings={isSettingsOpen}
            onSettingsClick={() => setIsSettingsOpen(!isSettingsOpen)}
            onModelClick={() => setIsModelSelectOpen(true)}
            onClearAll={clearConversation}
            hasMessages={hasMessages}
            searchMode={selectedConversation?.defaultSearchMode}
            showChatbar={showChatbar}
          />
        </div>

        {/* Messages container - always mounted to prevent scroll reset */}
        <div
          ref={chatContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden min-w-0"
        >
          {!hasMessages ? (
            /* Empty state with centered input */
            <div className="h-full flex flex-col items-center justify-center px-4 py-8">
              <div className="w-full flex flex-col items-center justify-center gap-6 -translate-y-12">
                {/* Logo and Heading */}
                <EmptyState
                  userName={getUserDisplayName(
                    session?.user,
                    displayNamePreference,
                    customDisplayName,
                  )}
                  user={session?.user}
                />

                {/* Centered Chat Input */}
                <div className="w-full max-w-3xl mx-auto relative z-50">
                  <ChatInput
                    onSend={handleSend}
                    onRegenerate={handleRegenerate}
                    onScrollDownClick={handleScrollDown}
                    stopConversationRef={stopConversationRef}
                    textareaRef={textareaRef}
                    showScrollDownButton={false}
                    showDisclaimer={false}
                    onTranscriptionStatusChange={setTranscriptionStatus}
                  />
                </div>

                {/* Suggested Prompts below input */}
                <div className="relative z-10">
                  <SuggestedPrompts onSelectPrompt={handleSelectPrompt} />
                </div>
              </div>
            </div>
          ) : (
            /* Messages */
            <div
              className={
                isArtifactOpen
                  ? 'w-full px-4 pb-4 min-w-0'
                  : 'mx-auto max-w-3xl pb-4'
              }
            >
              <ChatMessages
                messages={messages}
                isStreaming={isStreaming}
                streamingConversationId={streamingConversationId}
                selectedConversationId={selectedConversation?.id}
                smoothedContent={smoothedContent}
                isDraining={isDraining}
                citations={citations}
                loadingMessage={loadingMessage}
                transcriptionStatus={transcriptionStatus}
                lastMessageRef={lastMessageRef}
                messagesEndRef={messagesEndRef}
                onEditMessage={handleEditMessage}
                onSelectPrompt={handleSelectPrompt}
                onRegenerate={handleRegenerate}
                onSaveAsPrompt={handleOpenSavePromptModal}
                onNavigateVersion={handleNavigateVersion}
              />
            </div>
          )}
        </div>

        {/* Error Display */}
        <ChatError
          error={error}
          onClearError={clearError}
          onRegenerate={handleRegenerate}
          canRegenerate={canRegenerate}
        />

        {/* Model Switch Prompt (shown after successful retry) */}
        {showModelSwitchPrompt && (
          <ModelSwitchPrompt
            originalModelName={
              OpenAIModels[originalModelId as OpenAIModelID]?.name ||
              originalModelId ||
              'Unknown'
            }
            fallbackModelName={OpenAIModels[fallbackModelID]?.name || 'GPT-4.1'}
            onKeepOriginal={dismissModelSwitchPrompt}
            onSwitchModel={() => acceptModelSwitch(false)}
            onAlwaysSwitch={() => acceptModelSwitch(true)}
          />
        )}

        {/* Chat Input - Bottom position (hidden in empty state) */}
        {hasMessages && (
          <ChatInput
            onSend={handleSend}
            onRegenerate={handleRegenerate}
            onScrollDownClick={handleScrollDown}
            stopConversationRef={stopConversationRef}
            textareaRef={textareaRef}
            showScrollDownButton={showScrollDownButton}
            onTranscriptionStatusChange={setTranscriptionStatus}
          />
        )}

        {/* Model Selection Modal */}
        {isModelSelectOpen && (
          <div
            className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-[150] animate-fade-in-fast"
            onClick={() => setIsModelSelectOpen(false)}
          >
            <div
              className="max-w-4xl w-full max-h-[90vh] overflow-y-auto mx-4 rounded-lg bg-white dark:bg-[#212121] p-6 shadow-xl animate-modal-in"
              onClick={(e) => e.stopPropagation()}
            >
              <ModelSelect onClose={() => setIsModelSelectOpen(false)} />
            </div>
          </div>
        )}

        {/* Save Prompt Modal */}
        <PromptModal
          isOpen={isSavePromptModalOpen}
          onClose={handleCloseSavePromptModal}
          onSave={handleSavePrompt}
          initialName={savePromptName}
          initialDescription={savePromptDescription}
          initialContent={savePromptContent}
          title={t('Save as prompt')}
        />
      </div>

      {/* Resizer */}
      {isArtifactOpen && (
        <>
          <div
            onMouseDown={handleMouseDown}
            className={`relative w-1.5 bg-neutral-300 dark:bg-neutral-700 hover:bg-blue-500 dark:hover:bg-blue-500 cursor-col-resize transition-colors ${
              isResizing ? 'bg-blue-500 dark:bg-blue-500' : ''
            }`}
            style={{ flexShrink: 0 }}
          >
            {/* Drag Handle */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 pointer-events-none">
              <div className="w-1 h-1 rounded-full bg-neutral-500 dark:bg-neutral-400"></div>
              <div className="w-1 h-1 rounded-full bg-neutral-500 dark:bg-neutral-400"></div>
              <div className="w-1 h-1 rounded-full bg-neutral-500 dark:bg-neutral-400"></div>
            </div>
          </div>

          {/* Code/Document Editor Panel */}
          <div
            className="flex flex-col bg-white dark:bg-neutral-900 h-full overflow-hidden animate-slide-in-right min-w-0"
            style={{
              width: `${editorWidth}%`,
              minWidth: '20%',
              maxWidth: '80%',
            }}
          >
            {editorMode === 'code' ? (
              <CodeArtifact
                onClose={closeArtifact}
                onSwitchToDocument={
                  canSwitchToDocumentMode()
                    ? () => setEditorMode('document')
                    : undefined
                }
              />
            ) : (
              <DocumentArtifact
                onClose={closeArtifact}
                onSwitchToCode={() => setEditorMode('code')}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
