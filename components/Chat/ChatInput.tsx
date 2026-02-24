import {
  IconArrowDown,
  IconRepeat,
  IconSearch,
  IconVolume,
  IconWorld,
} from '@tabler/icons-react';
import {
  Dispatch,
  KeyboardEvent,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { useTranslations } from 'next-intl';

import { useChat } from '@/client/hooks/chat/useChat';
import { useMessageSender } from '@/client/hooks/chat/useMessageSender';
import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useTones } from '@/client/hooks/settings/useTones';
import { useTranscriptionPolling } from '@/client/hooks/transcription/useTranscriptionPolling';
import { usePromptSelection } from '@/client/hooks/ui/usePromptSelection';

import { FILE_SIZE_LIMITS } from '@/lib/utils/app/const';
import { isMobileDevice } from '@/lib/utils/client/device/detection';
import {
  shouldPreventSubmission,
  validateMessageSubmission,
} from '@/lib/utils/shared/chat/validation';
import {
  parseVariables,
  replaceVariablesWithMap,
} from '@/lib/utils/shared/chat/variables';

import { AgentType } from '@/types/agent';
import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  FilePreview,
  ImageFieldValue,
  ImageMessageContent,
  Message,
  MessageType,
  TextMessageContent,
} from '@/types/chat';
import { CodeInterpreterMode } from '@/types/codeInterpreter';
import { Prompt } from '@/types/prompt';
import { SearchMode } from '@/types/searchMode';

import { ArtifactContextBar } from '@/components/Chat/ChatInput/ArtifactContextBar';
import ChatFileUploadPreviews from '@/components/Chat/ChatInput/ChatFileUploadPreviews';
import ChatInputFile from '@/components/Chat/ChatInput/ChatInputFile';
import ChatInputImageCapture, {
  ChatInputImageCaptureRef,
} from '@/components/Chat/ChatInput/ChatInputImageCapture';
import { CodeInterpreterModeBadge } from '@/components/Chat/ChatInput/CodeInterpreterModeBadge';
import { InputControlsBar } from '@/components/Chat/ChatInput/InputControlsBar';
import { MessageTextarea } from '@/components/Chat/ChatInput/MessageTextarea';
import { SearchModeBadge } from '@/components/Chat/ChatInput/SearchModeBadge';
import { ToneBadge } from '@/components/Chat/ChatInput/ToneBadge';

import { PromptList } from './ChatInput/PromptList';
import { VariableModal } from './ChatInput/VariableModal';
import { TranscriptionProgressIndicator } from './TranscriptionProgressIndicator';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { UI_CONSTANTS } from '@/lib/constants/ui';

interface Props {
  onSend: (
    message: Message,
    searchMode?: SearchMode,
    codeInterpreterMode?: CodeInterpreterMode,
  ) => void;
  onRegenerate: () => void;
  onScrollDownClick: () => void;
  stopConversationRef: MutableRefObject<boolean>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  showScrollDownButton: boolean;
  showDisclaimer?: boolean;
  onTranscriptionStatusChange?: (status: string | null) => void;
}

export const ChatInput = ({
  onSend,
  onRegenerate,
  onScrollDownClick,
  stopConversationRef,
  textareaRef,
  showScrollDownButton,
  showDisclaimer = true,
  onTranscriptionStatusChange,
}: Props) => {
  const t = useTranslations();

  // Enable transcription status polling for batch jobs (>25MB files)
  useTranscriptionPolling();

  // Zustand hooks
  const { selectedConversation, folders } = useConversations();
  const { isStreaming, requestStop } = useChat();
  const { prompts } = useSettings();
  const { tones } = useTones();
  const { isArtifactOpen, fileName, language, closeArtifact } =
    useArtifactStore();

  // Pending conversation transcription (for large files >25MB)
  const pendingConversationTranscription = useChatStore(
    (state) => state.pendingConversationTranscription,
  );
  const isTranscriptionLocked = pendingConversationTranscription !== null;

  // Chat input store
  const textFieldValue = useChatInputStore((state) => state.textFieldValue);
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const placeholderText = useChatInputStore((state) => state.placeholderText);
  const setPlaceholderText = useChatInputStore(
    (state) => state.setPlaceholderText,
  );
  const isTyping = useChatInputStore((state) => state.isTyping);
  const setIsTyping = useChatInputStore((state) => state.setIsTyping);
  const isMultiline = useChatInputStore((state) => state.isMultiline);
  const setIsMultiline = useChatInputStore((state) => state.setIsMultiline);
  const isFocused = useChatInputStore((state) => state.isFocused);
  const setIsFocused = useChatInputStore((state) => state.setIsFocused);
  const textareaScrollHeight = useChatInputStore(
    (state) => state.textareaScrollHeight,
  );
  const setTextareaScrollHeight = useChatInputStore(
    (state) => state.setTextareaScrollHeight,
  );
  const transcriptionStatus = useChatInputStore(
    (state) => state.transcriptionStatus,
  );
  const setTranscriptionStatus = useChatInputStore(
    (state) => state.setTranscriptionStatus,
  );
  const isTranscribing = useChatInputStore((state) => state.isTranscribing);
  const setIsTranscribing = useChatInputStore(
    (state) => state.setIsTranscribing,
  );
  const searchMode = useChatInputStore((state) => state.searchMode);
  const setSearchMode = useChatInputStore((state) => state.setSearchMode);
  const codeInterpreterMode = useChatInputStore(
    (state) => state.codeInterpreterMode,
  );
  const setCodeInterpreterMode = useChatInputStore(
    (state) => state.setCodeInterpreterMode,
  );
  const selectedToneId = useChatInputStore((state) => state.selectedToneId);
  const setSelectedToneId = useChatInputStore(
    (state) => state.setSelectedToneId,
  );
  const clearInput = useChatInputStore((state) => state.clearInput);
  const filePreviews = useChatInputStore((state) => state.filePreviews);
  const setFilePreviews = useChatInputStore((state) => state.setFilePreviews);
  const fileFieldValue = useChatInputStore((state) => state.fileFieldValue);
  const setFileFieldValue = useChatInputStore(
    (state) => state.setFileFieldValue,
  );
  const imageFieldValue = useChatInputStore((state) => state.imageFieldValue);
  const setImageFieldValue = useChatInputStore(
    (state) => state.setImageFieldValue,
  );
  const uploadProgress = useChatInputStore((state) => state.uploadProgress);
  const setUploadProgress = useChatInputStore(
    (state) => state.setUploadProgress,
  );
  const submitType = useChatInputStore((state) => state.submitType);
  const setSubmitType = useChatInputStore((state) => state.setSubmitType);
  const handleFileUpload = useChatInputStore((state) => state.handleFileUpload);
  const usedPromptId = useChatInputStore((state) => state.usedPromptId);
  const setUsedPromptId = useChatInputStore((state) => state.setUsedPromptId);
  const usedPromptVariables = useChatInputStore(
    (state) => state.usedPromptVariables,
  );
  const setUsedPromptVariables = useChatInputStore(
    (state) => state.setUsedPromptVariables,
  );
  const resetForNewConversation = useChatInputStore(
    (state) => state.resetForNewConversation,
  );

  // Settings store
  const defaultCodeInterpreterMode = useSettingsStore(
    (state) => state.defaultCodeInterpreterMode,
  );

  // Message sending logic
  const { handleSend: handleMessageSend } = useMessageSender({
    textFieldValue,
    submitType,
    imageFieldValue,
    fileFieldValue,
    filePreviews,
    uploadProgress,
    selectedToneId,
    usedPromptId,
    usedPromptVariables,
    searchMode,
    codeInterpreterMode,
    onSend,
    onClearInput: clearInput,
    setSubmitType,
    setImageFieldValue,
    setFileFieldValue,
    setFilePreviews,
    setUsedPromptId,
    setUsedPromptVariables,
  });

  const [variables, setVariables] = useState<string[]>([]);
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const [selectedPromptForModal, setSelectedPromptForModal] =
    useState<Prompt | null>(null);

  const cameraRef = useRef<ChatInputImageCaptureRef>(null);

  // Reset input when conversation changes
  useEffect(() => {
    resetForNewConversation(
      selectedConversation?.defaultSearchMode,
      defaultCodeInterpreterMode,
    );
  }, [
    selectedConversation?.id,
    selectedConversation?.defaultSearchMode,
    defaultCodeInterpreterMode,
    resetForNewConversation,
  ]);

  const {
    showPromptList,
    setShowPromptList,
    activePromptIndex,
    setActivePromptIndex,
    promptInputValue,
    filteredPrompts,
    promptListRef,
    handlePromptSelect: handlePromptSelectFromHook,
    handleKeyDownPromptList,
    handleInitModal,
    updatePromptListVisibilityCallback,
    findAndSelectMatchingPrompt,
  } = usePromptSelection({
    prompts,
    onPromptSelect: (prompt, parsedVariables, hasVariables) => {
      setVariables(parsedVariables);

      if (hasVariables) {
        setSelectedPromptForModal(prompt);
        setIsModalVisible(true);
      } else {
        setTextFieldValue((prevContent) => {
          const updatedContent = prevContent?.replace(/\/\w*$/, prompt.content);
          return updatedContent;
        });
        updatePromptListVisibilityCallback(prompt.content);
      }
    },
    onResetInputState: () => {
      if (submitType !== 'TEXT') {
        setSubmitType('TEXT');
      }
      if (filePreviews.length > 0) {
        setFilePreviews([]);
      }
    },
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value: string = e.target.value;
    const maxLength: number | undefined =
      selectedConversation?.model?.maxLength;

    if (maxLength && value.length > maxLength) {
      alert(
        t(
          `Message limit is {{maxLength}} characters. You have entered {{valueLength}} characters.`,
          { maxLength, valueLength: value.length },
        ),
      );
      return;
    }

    setTextFieldValue(value);
    updatePromptListVisibilityCallback(value);
  };

  const handleSend = () => {
    if (isStreaming) {
      if (filePreviews.length > 0) {
        setFilePreviews([]);
      }
      return;
    }

    handleMessageSend();

    if (
      window.innerWidth < UI_CONSTANTS.BREAKPOINTS.MOBILE &&
      textareaRef?.current
    ) {
      textareaRef.current.blur();
    }
  };

  const handleStopConversation = () => {
    stopConversationRef.current = true;
    requestStop();
  };

  const isMobile = isMobileDevice;

  const handleKeyDownInput = (
    key: string,
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      key === 'Enter' &&
      !isTyping &&
      !isMobile() &&
      !event.shiftKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      handleSend();
      if (submitType !== 'TEXT') {
        setSubmitType('TEXT');
      }
      if (filePreviews.length > 0) {
        setFilePreviews([]);
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPromptList) {
      handleKeyDownPromptList(e);
    } else {
      handleKeyDownInput(e.key, e);
    }
  };

  const handleSubmit = (
    updatedVariables: string[],
    variableMap: { [key: string]: string },
  ) => {
    if (!selectedPromptForModal) return;

    // Use variableMap for cleaner replacement with default value support
    const contentWithVariables = replaceVariablesWithMap(
      selectedPromptForModal.content,
      variableMap,
    );

    // Replace the /prompt text in the input with the filled-in content
    const newContent = textFieldValue?.replace(/\/\w*$/, contentWithVariables);
    setTextFieldValue(newContent);

    // Track which prompt was used and the variable values
    setUsedPromptId(selectedPromptForModal.id);
    setUsedPromptVariables(variableMap);

    setFilePreviews([]);
    setSelectedPromptForModal(null);

    if (textareaRef?.current) {
      textareaRef.current.focus();
    }
  };

  useEffect(() => {
    if (textareaRef && textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current?.scrollHeight}px`;
      textareaRef.current.style.overflow = `${
        textareaRef?.current?.scrollHeight > UI_CONSTANTS.TEXTAREA.MAX_HEIGHT
          ? 'auto'
          : 'hidden'
      }`;

      // Store scroll height in state for use in render
      setTextareaScrollHeight(textareaRef.current.scrollHeight);

      // Check if textarea is multiline - single line is typically ~44px or less
      // Only consider it multiline if scrollHeight exceeds threshold to avoid false positives
      setIsMultiline(
        textareaRef.current.scrollHeight >
          UI_CONSTANTS.TEXTAREA.MULTILINE_THRESHOLD,
      );
    }
  }, [
    textFieldValue,
    searchMode,
    selectedToneId,
    textareaRef,
    setTextareaScrollHeight,
    setIsMultiline,
  ]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        promptListRef.current &&
        !promptListRef.current.contains(e.target as Node)
      ) {
        setShowPromptList(false);
      }
    };

    window.addEventListener('click', handleOutsideClick);

    return () => {
      window.removeEventListener('click', handleOutsideClick);
    };
    // Refs and setState functions are stable and don't need to be dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTimeout(() => {
      setPlaceholderText(t('Ask Anything'));
    }, 0);
  }, [t, setPlaceholderText]);

  // Notify parent when transcription status changes
  useEffect(() => {
    onTranscriptionStatusChange?.(transcriptionStatus);
  }, [transcriptionStatus, onTranscriptionStatusChange]);

  // Clear file attachments when switching conversations
  useEffect(() => {
    setTimeout(() => {
      setFilePreviews([]);
      setFileFieldValue(null);
      setImageFieldValue(null);
      setUploadProgress({});
      setSubmitType('TEXT');
    }, 0);
    // setState functions are stable and don't need to be dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation?.id]);

  // File upload handler
  const handleFiles = (files: FileList | File[]) => {
    const filesArray = Array.from(files);

    if (filesArray.length > 0) {
      handleFileUpload(filesArray);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleFiles,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
      'application/pdf': ['.pdf'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        ['.docx'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
        '.xlsx',
      ],
      'application/vnd.ms-powerpoint': ['.ppt'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        ['.pptx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: FILE_SIZE_LIMITS.FILE_MAX_BYTES,
    maxFiles: 5,
    noClick: true, // Don't trigger file picker on click
    noKeyboard: true, // Don't trigger on keyboard
  });

  const preventSubmission = (): boolean =>
    isTranscriptionLocked ||
    shouldPreventSubmission(
      isTranscribing,
      isStreaming,
      filePreviews,
      uploadProgress,
    );

  const inputPlaceholder = isTranscribing
    ? t('transcribingChatPlaceholder')
    : searchMode === SearchMode.ALWAYS
      ? 'Search the web'
      : codeInterpreterMode === CodeInterpreterMode.ALWAYS
        ? t('codeInterpreter.alwaysPlaceholder')
        : placeholderText;

  return (
    <div
      {...getRootProps()}
      className={`bg-white dark:bg-[#212121] transition-colors ${isDragActive ? 'bg-blue-50 dark:bg-blue-900/30 border-t border-blue-300 dark:border-blue-700' : ''}`}
    >
      <input {...getInputProps()} />
      {isDragActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-50/70 dark:bg-blue-900/30 backdrop-blur-sm z-10 pointer-events-none">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg text-center">
            <div className="text-blue-500 mb-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mx-auto h-12 w-12"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
                />
              </svg>
            </div>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 bg-white dark:bg-[#212121]">
        {filePreviews.length > 0 && (
          <div className="max-h-52 overflow-y-auto">
            <ChatFileUploadPreviews
              filePreviews={filePreviews}
              setFilePreviews={setFilePreviews}
              setSubmitType={setSubmitType}
              uploadProgress={uploadProgress}
            />
          </div>
        )}

        {/* Transcription Progress Indicator - Shows when large file transcription is pending */}
        {pendingConversationTranscription && (
          <div className="px-4 py-2">
            <TranscriptionProgressIndicator
              startedAt={pendingConversationTranscription.startedAt}
              filename={pendingConversationTranscription.filename}
              progress={pendingConversationTranscription.progress}
            />
          </div>
        )}

        {/* Artifact Context Bar - Shows when code editor is open */}
        {isArtifactOpen && (
          <ArtifactContextBar
            fileName={fileName}
            language={language}
            onClose={closeArtifact}
          />
        )}

        <div className="items-center pt-4">
          <div className="flex justify-center items-center space-x-2 px-2 md:px-4">
            <ChatInputImageCapture
              ref={cameraRef}
              setSubmitType={setSubmitType}
              prompt={textFieldValue}
              setFilePreviews={setFilePreviews}
              setFileFieldValue={setFileFieldValue}
              setImageFieldValue={setImageFieldValue}
              setUploadProgress={setUploadProgress}
              visible={false}
              hasCameraSupport={true}
            />

            <div className="relative mx-auto w-full max-w-3xl flex-grow px-2 sm:px-4">
              <div
                className={`relative flex w-full flex-col rounded-full border border-gray-300 bg-white dark:border-0 dark:bg-[#40414F] dark:text-white focus-within:outline-none focus-within:ring-0 z-0 ${searchMode === SearchMode.ALWAYS || codeInterpreterMode === CodeInterpreterMode.ALWAYS || selectedToneId ? 'min-h-[80px] !rounded-3xl' : ''} ${isMultiline && searchMode !== SearchMode.ALWAYS && codeInterpreterMode !== CodeInterpreterMode.ALWAYS && !selectedToneId ? '!rounded-2xl' : ''}`}
              >
                <MessageTextarea
                  textareaRef={textareaRef}
                  value={textFieldValue}
                  placeholder={inputPlaceholder}
                  disabled={preventSubmission()}
                  searchMode={searchMode}
                  selectedToneId={selectedToneId}
                  textareaScrollHeight={textareaScrollHeight}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  onCompositionStart={() => setIsTyping(true)}
                  onCompositionEnd={() => setIsTyping(false)}
                />

                {/* Bottom row with badges and controls */}
                <div
                  className={`absolute left-2 flex items-center gap-2 z-[10001] transition-all duration-200 ${
                    searchMode === SearchMode.ALWAYS ||
                    codeInterpreterMode === CodeInterpreterMode.ALWAYS ||
                    selectedToneId ||
                    isMultiline
                      ? 'bottom-2'
                      : 'top-1/2 transform -translate-y-1/2'
                  }`}
                >
                  {/* Note: ChatDropdown is now part of InputControlsBar - kept here for consistency */}
                </div>

                <InputControlsBar
                  onCameraClick={() => {
                    cameraRef.current?.triggerCamera();
                  }}
                  showDisclaimer={showDisclaimer}
                  tones={tones}
                  isStreaming={isStreaming}
                  handleStopConversation={handleStopConversation}
                  preventSubmission={preventSubmission}
                  handleSend={handleSend}
                />

                {/* Badges displayed after dropdown */}
                <div
                  className={`absolute left-14 flex items-center gap-2 z-[10000] transition-all duration-200 ${
                    searchMode === SearchMode.ALWAYS ||
                    codeInterpreterMode === CodeInterpreterMode.ALWAYS ||
                    selectedToneId ||
                    isMultiline
                      ? 'bottom-2'
                      : 'top-1/2 transform -translate-y-1/2'
                  }`}
                >
                  {searchMode === SearchMode.ALWAYS && (
                    <SearchModeBadge
                      onRemove={() =>
                        setSearchMode(
                          selectedConversation?.defaultSearchMode ??
                            SearchMode.OFF,
                        )
                      }
                    />
                  )}

                  {codeInterpreterMode === CodeInterpreterMode.ALWAYS && (
                    <CodeInterpreterModeBadge
                      mode={codeInterpreterMode}
                      onRemove={() =>
                        setCodeInterpreterMode(CodeInterpreterMode.OFF)
                      }
                    />
                  )}

                  {selectedToneId && (
                    <ToneBadge
                      toneId={selectedToneId}
                      tones={tones}
                      onRemove={() => setSelectedToneId(null)}
                    />
                  )}
                </div>

                <div
                  className={`absolute bottom-20 left-1/2 -translate-x-1/2 md:bottom-16 z-[9999] transition-all duration-200 ease-in-out ${
                    showScrollDownButton && !isFocused
                      ? 'opacity-100 scale-100 pointer-events-auto'
                      : 'opacity-0 scale-90 pointer-events-none'
                  }`}
                >
                  <button
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-300 text-gray-800 shadow-md hover:shadow-lg focus:outline-none dark:bg-gray-700 dark:text-neutral-200 transition-shadow"
                    onClick={(e) => {
                      onScrollDownClick();
                      e.currentTarget.blur(); // Remove focus after click
                    }}
                    aria-label={t('chat.scrollToBottom')}
                  >
                    <IconArrowDown size={18} />
                  </button>
                </div>

                {showPromptList && filteredPrompts.length > 0 && (
                  <div className="absolute bottom-12 w-full">
                    <PromptList
                      activePromptIndex={activePromptIndex}
                      prompts={filteredPrompts}
                      onSelect={handleInitModal}
                      onMouseOver={setActivePromptIndex}
                      promptListRef={promptListRef}
                      folders={folders}
                    />
                  </div>
                )}
              </div>
            </div>

            {isModalVisible && selectedPromptForModal && (
              <VariableModal
                prompt={selectedPromptForModal}
                variables={variables}
                onSubmit={handleSubmit}
                onClose={() => {
                  setIsModalVisible(false);
                  setSelectedPromptForModal(null);
                }}
              />
            )}
          </div>
        </div>
      </div>
      {showDisclaimer && (
        <div className="px-3 pt-1 pb-3 text-center items-center text-[12px] text-black/50 dark:text-white/50 md:px-4 md:pt-1 md:pb-3">
          {t('chatDisclaimer')}
        </div>
      )}
    </div>
  );
};
