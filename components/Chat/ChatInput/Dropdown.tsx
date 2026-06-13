import {
  IconBraces,
  IconCamera,
  IconCirclePlus,
  IconFileMusic,
  IconFileText,
  IconLanguage,
  IconPaperclip,
  IconVolume,
  IconWorld,
} from '@tabler/icons-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useLocale, useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useDropdownKeyboardNav } from '@/client/hooks/ui/useDropdownKeyboardNav';
import useEnhancedOutsideClick from '@/client/hooks/ui/useEnhancedOutsideClick';
import { useIsMobile } from '@/client/hooks/ui/useIsMobile';

import { normalizeForSearch } from '@/lib/utils/app/localeSearch';

import {
  AssistantMessageGroup,
  FileMessageContent,
  Message,
} from '@/types/chat';
import { DocumentTranslationReference } from '@/types/documentTranslation';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

import ChatInputDocumentTranslate from '@/components/Chat/ChatInput/ChatInputDocumentTranslate';
import ChatInputImage from '@/components/Chat/ChatInput/ChatInputImage';
import ChatInputImageCapture from '@/components/Chat/ChatInput/ChatInputImageCapture';
import ChatInputTranslate from '@/components/Chat/ChatInput/ChatInputTranslate';
import { DropdownSearchInput } from '@/components/Chat/ChatInput/DropdownSearchInput';
import { formatTranslationReference } from '@/components/Chat/DocumentTranslationViewer';
import Modal from '@/components/UI/Modal';

import { DropdownCategoryGroup } from './DropdownCategoryGroup';
import { DropdownMenuItem, MenuItem } from './DropdownMenuItem';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import {
  ATTACH_ACCEPT_TYPES,
  DOCUMENT_TRANSLATION_ACCEPT_TYPES,
  TRANSCRIPTION_ACCEPT_TYPES,
} from '@/lib/constants/fileTypes';

interface DropdownProps {
  onCameraClick: () => void;
  openDownward?: boolean;
  tones: Tone[];
  handleSend: () => void;
}

const Dropdown: React.FC<DropdownProps> = ({
  onCameraClick,
  openDownward = false,
  tones,
  handleSend,
}) => {
  const setFileFieldValue = useChatInputStore(
    (state) => state.setFileFieldValue,
  );
  const handleFileUpload = useChatInputStore((state) => state.handleFileUpload);
  const setFilePreviews = useChatInputStore((state) => state.setFilePreviews);
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const setImageFieldValue = useChatInputStore(
    (state) => state.setImageFieldValue,
  );
  const setUploadProgress = useChatInputStore(
    (state) => state.setUploadProgress,
  );
  const setSubmitType = useChatInputStore((state) => state.setSubmitType);
  const textFieldValue = useChatInputStore((state) => state.textFieldValue);
  const searchMode = useChatInputStore((state) => state.searchMode);
  const setSearchMode = useChatInputStore((state) => state.setSearchMode);
  const extractionMode = useChatInputStore((state) => state.extractionMode);
  const setExtractionMode = useChatInputStore(
    (state) => state.setExtractionMode,
  );
  const setTranscriptionStatus = useChatInputStore(
    (state) => state.setTranscriptionStatus,
  );
  const selectedToneId = useChatInputStore((state) => state.selectedToneId);
  const setSelectedToneId = useChatInputStore(
    (state) => state.setSelectedToneId,
  );
  const filePreviews = useChatInputStore((state) => state.filePreviews);
  const pinnedToolIds = useSettingsStore((state) => state.pinnedToolIds);
  const toolUsageCounts = useSettingsStore((state) => state.toolUsageCounts);
  const togglePinnedTool = useSettingsStore((state) => state.togglePinnedTool);
  const incrementToolUsage = useSettingsStore(
    (state) => state.incrementToolUsage,
  );
  const { selectedConversation, updateConversation } = useConversations();

  const [isOpen, setIsOpen] = useState(false);
  const [isTranslateOpen, setIsTranslateOpen] = useState(false);
  const [isDocumentTranslateOpen, setIsDocumentTranslateOpen] = useState(false);
  const [documentToTranslate, setDocumentToTranslate] = useState<File | null>(
    null,
  );
  const [isImageOpen, setIsImageOpen] = useState(false);
  const [isToneOpen, setIsToneOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [query, setQuery] = useState('');
  const [hasCameraSupport, setHasCameraSupport] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const locale = useLocale();
  const isMobile = useIsMobile();

  useEffect(() => {
    const checkCameraSupport = async () => {
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasCamera = devices.some(
            (device) => device.kind === 'videoinput',
          );
          setHasCameraSupport(hasCamera);
        } else {
          console.error('MediaDevices API not supported');
          setHasCameraSupport(false);
        }
      } catch (error) {
        console.error('Error checking camera support:', error);
        setHasCameraSupport(false);
      }
    };

    checkCameraSupport();
  }, []);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSelectedIndex(-1);
    setQuery('');
  }, []);

  const t = useTranslations();

  const chatInputImageRef = useRef<{ openFilePicker: () => void }>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcribeInputRef = useRef<HTMLInputElement>(null);
  const documentTranslateInputRef = useRef<HTMLInputElement>(null);

  // Handler for file attach that doesn't access ref during render
  const handleAttachClick = useCallback(() => {
    closeDropdown();
    fileInputRef.current?.click();
  }, [closeDropdown]);

  // Listen for keyboard shortcut to attach file (Ctrl+Shift+U)
  useEffect(() => {
    const handleKeyboardAttach = () => {
      fileInputRef.current?.click();
    };

    document.addEventListener('keyboard-attach-file', handleKeyboardAttach);
    return () => {
      document.removeEventListener(
        'keyboard-attach-file',
        handleKeyboardAttach,
      );
    };
  }, []);

  // Handler for transcribe audio/video file selection
  const handleTranscribeClick = useCallback(() => {
    closeDropdown();
    transcribeInputRef.current?.click();
  }, [closeDropdown]);

  // Handler for document translation file selection
  const handleDocumentTranslateClick = useCallback(() => {
    const input = documentTranslateInputRef.current;
    if (!input) {
      console.error('[DocumentTranslation] file input ref unavailable');
      return;
    }
    // Open the picker first, while the user gesture is still active, before any
    // close-related state churn.
    input.click();
    closeDropdown();
  }, [closeDropdown]);

  // Handle document translation completion - add user message with file + assistant message
  const handleDocumentTranslationComplete = useCallback(
    (reference: DocumentTranslationReference) => {
      if (!selectedConversation) {
        console.error('[DocumentTranslation] No conversation selected');
        setIsDocumentTranslateOpen(false);
        setDocumentToTranslate(null);
        return;
      }

      // 1. Create user message showing the original uploaded file
      const fileContent: FileMessageContent = {
        type: 'file_url',
        url: reference.originalFileUrl,
        originalFilename: reference.originalFilename,
      };

      const userMessage: Message = {
        role: 'user',
        content: [fileContent],
        messageType: 'FILE',
      };

      // 2. Create assistant message with the translation reference
      const referenceText = formatTranslationReference(
        reference.translatedFilename,
        reference.targetLanguage,
        reference.jobId,
        reference.fileExtension,
        reference.expiresAt,
      );

      const assistantMessage: AssistantMessageGroup = {
        type: 'assistant_group',
        versions: [
          {
            content: referenceText,
            messageType: 'TEXT',
            createdAt: new Date().toISOString(),
          },
        ],
        activeIndex: 0,
      };

      // 3. Add both messages to the conversation
      const updatedMessages = [
        ...selectedConversation.messages,
        userMessage,
        assistantMessage,
      ];

      // 4. Build updates object - include title if conversation is untitled
      const updates: { messages: typeof updatedMessages; name?: string } = {
        messages: updatedMessages,
      };

      // Auto-title empty conversations
      if (
        !selectedConversation.name ||
        selectedConversation.name === 'New Conversation'
      ) {
        updates.name = `Translation: ${reference.originalFilename}`;
      }

      updateConversation(selectedConversation.id, updates);

      // Close modal
      setIsDocumentTranslateOpen(false);
      setDocumentToTranslate(null);
    },
    [selectedConversation, updateConversation],
  );

  // Helper function to toggle search mode (always sets to ALWAYS when enabled)
  const toggleSearchMode = useCallback(() => {
    if (searchMode === SearchMode.ALWAYS) {
      // If ALWAYS is active, turn it off (return to conversation's default or OFF)
      setSearchMode(selectedConversation?.defaultSearchMode ?? SearchMode.OFF);
    } else {
      // If OFF or INTELLIGENT, enable ALWAYS mode
      setSearchMode(SearchMode.ALWAYS);
    }
  }, [searchMode, setSearchMode, selectedConversation?.defaultSearchMode]);

  // Per-item icon color is a deliberate carve-out: this menu is scanned often
  // and the hue helps locate actions at a glance. Each color matches its
  // canonical use elsewhere in the app (search/extract: signal-blue,
  // tone: purple, transcribe: caution-amber-ish orange, translate-doc: indigo,
  // camera: red). Color is always paired with an icon shape and a label so it
  // is never the only distinguishing factor.
  const menuItems: MenuItem[] = useMemo(
    () => [
      {
        id: 'search',
        icon: <IconWorld size={18} className="text-blue-500 flex-shrink-0" />,
        label: t('webSearchDropdown'),
        infoTooltip: t('dropdown.searchTooltip'),
        onClick: () => {
          toggleSearchMode();
          closeDropdown();
        },
        category: 'web',
        toggle: true,
        checked: searchMode === SearchMode.ALWAYS,
      },
      {
        id: 'tone',
        icon: (
          <IconVolume
            size={18}
            className={`flex-shrink-0 ${tones.length === 0 ? 'text-gray-400' : 'text-purple-500'}`}
          />
        ),
        label: selectedToneId
          ? `${t('toneDropdown')}: ${tones.find((tone) => tone.id === selectedToneId)?.name || t('dropdown.selected')}`
          : t('toneDropdown'),
        infoTooltip:
          tones.length === 0
            ? t('noTonesAvailable')
            : t('applyCustomVoiceProfile'),
        onClick: () => {
          setIsToneOpen(true);
          closeDropdown();
        },
        category: 'web',
        disabled: tones.length === 0,
        opensDialog: true,
      },
      {
        id: 'attach',
        icon: (
          <IconPaperclip
            size={18}
            className="flex-shrink-0 text-gray-700 dark:text-gray-300"
          />
        ),
        label: t('attachFilesDropdown'),
        infoTooltip: t('dropdown.attachTooltip'),
        onClick: handleAttachClick,
        category: 'media',
      },
      {
        id: 'transcribe',
        icon: (
          <IconFileMusic size={18} className="text-orange-500 flex-shrink-0" />
        ),
        label: t('transcribeAudioVideoDropdown'),
        infoTooltip: t('dropdown.transcribeTooltip'),
        onClick: handleTranscribeClick,
        category: 'media',
      },
      {
        id: 'translate',
        icon: (
          <IconLanguage size={18} className="text-teal-500 flex-shrink-0" />
        ),
        label: t('translateTextDropdown'),
        infoTooltip: t('dropdown.translateTooltip'),
        onClick: () => {
          setIsTranslateOpen(true);
          closeDropdown();
        },
        category: 'transform',
        opensDialog: true,
      },
      {
        id: 'extract',
        icon: <IconBraces size={18} className="text-blue-500 flex-shrink-0" />,
        label: t('extraction.toggleLabel'),
        infoTooltip: t('extraction.trayInfo'),
        onClick: () => {
          setExtractionMode(!extractionMode);
          closeDropdown();
        },
        category: 'transform',
        toggle: true,
        checked: extractionMode,
      },
      {
        id: 'translateDocument',
        icon: (
          <IconFileText size={18} className="text-indigo-500 flex-shrink-0" />
        ),
        label: t('translateDocumentDropdown'),
        infoTooltip: t('dropdown.translateDocumentTooltip'),
        onClick: handleDocumentTranslateClick,
        category: 'transform',
        opensDialog: true,
      },
      ...(hasCameraSupport
        ? [
            {
              id: 'camera',
              icon: (
                <IconCamera size={18} className="text-red-500 flex-shrink-0" />
              ),
              label: t('cameraDropdown'),
              infoTooltip: t('dropdown.cameraTooltip'),
              onClick: () => {
                onCameraClick();
                closeDropdown();
              },
              category: 'media' as 'web' | 'media' | 'transform',
              opensDialog: true,
            },
          ]
        : []),
    ],
    [
      t,
      searchMode,
      selectedToneId,
      tones,
      hasCameraSupport,
      extractionMode,
      setExtractionMode,
      closeDropdown,
      setIsToneOpen,
      setIsTranslateOpen,
      onCameraClick,
      handleAttachClick,
      handleTranscribeClick,
      handleDocumentTranslateClick,
      toggleSearchMode,
    ],
  );

  // Wrap each action so activating it records usage (drives "Frequently used").
  // Pinning does not count — it's a separate control on the row.
  const trackedItems = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- onClick handlers reference refs only when invoked, not during render
      menuItems.map((item) => ({
        ...item,
        onClick: () => {
          incrementToolUsage(item.id);
          item.onClick();
        },
      })),
    [menuItems, incrementToolUsage],
  );

  const normalizedQuery = normalizeForSearch(query, locale);
  const isFiltering = normalizedQuery.length > 0;

  // Build the sectioned view (unfiltered) or a flat filtered list. Each item
  // appears exactly once: Pinned, else Frequently used, else its category.
  const { sections, flatVisibleItems } = useMemo(() => {
    if (isFiltering) {
      const filtered = trackedItems.filter((item) =>
        normalizeForSearch(item.label, locale).includes(normalizedQuery),
      );
      return { sections: [], flatVisibleItems: filtered };
    }

    const pinnedSet = new Set(pinnedToolIds);
    const pinned = pinnedToolIds
      .map((id) => trackedItems.find((item) => item.id === id))
      .filter((item): item is (typeof trackedItems)[number] => Boolean(item));

    const frequent = trackedItems
      .filter(
        (item) =>
          !pinnedSet.has(item.id) && (toolUsageCounts[item.id] ?? 0) >= 2,
      )
      .sort(
        (a, b) => (toolUsageCounts[b.id] ?? 0) - (toolUsageCounts[a.id] ?? 0),
      )
      .slice(0, 3);
    const frequentSet = new Set(frequent.map((item) => item.id));

    const remaining = trackedItems.filter(
      (item) => !pinnedSet.has(item.id) && !frequentSet.has(item.id),
    );
    const byCategory = (category: MenuItem['category']) =>
      remaining.filter((item) => item.category === category);

    const built = [
      { key: 'pinned', label: t('dropdown.sectionPinned'), items: pinned },
      {
        key: 'frequent',
        label: t('dropdown.sectionFrequent'),
        items: frequent,
      },
      {
        key: 'web',
        label: t('dropdown.categoryWeb'),
        items: byCategory('web'),
      },
      {
        key: 'media',
        label: t('dropdown.categoryMedia'),
        items: byCategory('media'),
      },
      {
        key: 'transform',
        label: t('dropdown.categoryTransform'),
        items: byCategory('transform'),
      },
    ].filter((section) => section.items.length > 0);

    return {
      sections: built,
      flatVisibleItems: built.flatMap((section) => section.items),
    };
  }, [
    isFiltering,
    normalizedQuery,
    trackedItems,
    locale,
    pinnedToolIds,
    toolUsageCounts,
    t,
  ]);

  // Keep the highlight on the first item as the visible list changes
  useEffect(() => {
    setSelectedIndex(flatVisibleItems.length ? 0 : -1);
  }, [query, flatVisibleItems.length]);

  // Focus the search box on open (desktop only — on mobile this would pop the
  // keyboard over the sheet before the user has chosen to filter)
  useEffect(() => {
    if (isOpen && !isMobile) {
      searchInputRef.current?.focus();
    }
  }, [isOpen, isMobile]);

  // Use keyboard navigation hook (operates on the visible list, in render order)
  const { handleKeyDown } = useDropdownKeyboardNav({
    isOpen,
    items: flatVisibleItems,
    selectedIndex,
    setSelectedIndex,
    closeDropdown,
    onCloseModals: () => {
      setIsTranslateOpen(false);
      setIsDocumentTranslateOpen(false);
      setIsImageOpen(false);
      setIsToneOpen(false);
    },
  });

  // Escape clears the query first (if any), then closes on the next press
  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && query) {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        return;
      }
      handleKeyDown(event);
    },
    [query, handleKeyDown],
  );

  const activeDescendantId =
    selectedIndex >= 0 && flatVisibleItems[selectedIndex]
      ? `dropdown-item-${flatVisibleItems[selectedIndex].id}`
      : undefined;

  // Logic to handle clicks outside the Dropdown Menu
  useEnhancedOutsideClick(dropdownRef, closeDropdown, isOpen, true);

  return (
    <div className="relative">
      {/* Toggle Dropdown Button — 44x44 hit area per AAA touch target */}
      <button
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (isOpen) {
            closeDropdown();
          } else {
            setIsOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('common.toggleDropdownMenu')}
        className="focus:outline-none inline-flex items-center justify-center min-h-11 px-2.5 -ml-2.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors duration-200"
      >
        <IconCirclePlus className="w-7 h-7 md:w-6 md:h-6 text-black dark:text-white" />
      </button>

      {/* Search box + item list, shared by the desktop menu and the mobile sheet */}
      {(() => {
        const menuBody = (scrollClassName: string) => (
          <>
            <DropdownSearchInput
              value={query}
              onChange={setQuery}
              onClear={() => setQuery('')}
              inputRef={searchInputRef}
              placeholder={t('chat.searchFeatures')}
            />
            <div
              className={`${scrollClassName} overflow-y-auto custom-scrollbar p-1`}
            >
              {flatVisibleItems.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  {t('dropdown.noResults')}
                </div>
              ) : isFiltering ? (
                flatVisibleItems.map((item, index) => (
                  <DropdownMenuItem
                    key={item.id}
                    item={item}
                    isSelected={index === selectedIndex}
                    pinnable
                    pinned={pinnedToolIds.includes(item.id)}
                    onTogglePin={() => togglePinnedTool(item.id)}
                  />
                ))
              ) : (
                sections.map((section) => (
                  <DropdownCategoryGroup
                    key={section.key}
                    label={section.label}
                    items={section.items}
                    flattenedItems={flatVisibleItems}
                    selectedIndex={selectedIndex}
                    pinnedToolIds={pinnedToolIds}
                    onTogglePin={togglePinnedTool}
                  />
                ))
              )}
            </div>
          </>
        );

        // Desktop: anchored menu, capped to the viewport so it never overflows
        if (isOpen && !isMobile) {
          return (
            <div
              ref={dropdownRef}
              className={`absolute ${openDownward ? 'top-full mt-2 z-[10000]' : 'bottom-full mb-2 z-[9999]'} left-0 flex flex-col bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg w-64 outline-none overflow-hidden ${
                openDownward ? 'animate-slide-down-reverse' : 'animate-slide-up'
              }`}
              tabIndex={-1}
              role="menu"
              aria-activedescendant={activeDescendantId}
              onKeyDown={handleMenuKeyDown}
            >
              {menuBody('max-h-[min(20rem,70dvh)]')}
            </div>
          );
        }

        // Mobile: bottom sheet portaled to the body, with a tap-to-dismiss scrim
        if (isOpen && isMobile && typeof document !== 'undefined') {
          return createPortal(
            <>
              <div
                className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm animate-fade-in-fast"
                aria-hidden="true"
                onClick={closeDropdown}
              />
              <div
                ref={dropdownRef}
                className="fixed inset-x-0 bottom-0 z-[10001] flex max-h-[75dvh] flex-col rounded-t-2xl border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg outline-none animate-slide-up pb-[env(safe-area-inset-bottom)]"
                tabIndex={-1}
                role="menu"
                aria-activedescendant={activeDescendantId}
                onKeyDown={handleMenuKeyDown}
              >
                {menuBody('flex-1')}
              </div>
            </>,
            document.body,
          );
        }

        return null;
      })()}

      {/* Chat Input Image Capture Modal */}
      {isImageOpen && (
        <ChatInputImageCapture
          setFilePreviews={setFilePreviews}
          setSubmitType={setSubmitType}
          prompt={textFieldValue}
          setFileFieldValue={setFileFieldValue}
          setImageFieldValue={setImageFieldValue}
          setUploadProgress={setUploadProgress}
          hasCameraSupport={hasCameraSupport}
        />
      )}

      {/* Chat Input Translate Modal */}
      {isTranslateOpen && (
        <ChatInputTranslate
          defaultText={textFieldValue}
          setTextFieldValue={setTextFieldValue}
          handleSend={handleSend}
          setParentModalIsOpen={setIsTranslateOpen}
          simulateClick={true}
        />
      )}

      {/* Tone Selector Modal */}
      <Modal
        isOpen={isToneOpen}
        onClose={() => setIsToneOpen(false)}
        title={t('dropdown.selectTone')}
        size="md"
        className="z-[10000]"
      >
        <p className="text-xs text-gray-500 dark:text-gray-400 -mt-2 mb-4">
          {t('dropdown.selectToneDescription')}
        </p>
        <div className="max-h-96 overflow-y-auto -mx-2 px-2">
          <button
            onClick={() => {
              setSelectedToneId(null);
              setIsToneOpen(false);
            }}
            className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all mb-2 ${
              !selectedToneId
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <div className="font-medium text-gray-900 dark:text-white">
              {t('dropdown.noToneDefault')}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {t('dropdown.useDefaultStyle')}
            </div>
          </button>

          {tones.map((tone) => (
            <button
              key={tone.id}
              onClick={() => {
                setSelectedToneId(tone.id);
                setIsToneOpen(false);
              }}
              className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all mb-2 ${
                selectedToneId === tone.id
                  ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              <div className="font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <IconVolume size={16} className="text-purple-500" />
                {tone.name}
              </div>
              {tone.description && (
                <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {tone.description}
                </div>
              )}
              {tone.tags && tone.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {tone.tags.slice(0, 3).map((tag, idx) => (
                    <span
                      key={idx}
                      className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}

          {tones.length === 0 && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <IconVolume size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm">{t('dropdown.noTonesCreated')}</p>
              <p className="text-xs mt-1">{t('dropdown.createTonesHint')}</p>
            </div>
          )}
        </div>
      </Modal>

      {/* Chat Input Image Component (hidden) */}
      <ChatInputImage
        imageInputRef={chatInputImageRef}
        setSubmitType={setSubmitType}
        prompt={textFieldValue}
        setFilePreviews={setFilePreviews}
        setFileFieldValue={setFileFieldValue}
        setImageFieldValue={setImageFieldValue}
        setUploadProgress={setUploadProgress}
        setParentModalIsOpen={setIsImageOpen}
        simulateClick={false}
        labelText=""
      />

      {/* Hidden file input for all file types: images, documents, data, code, audio, and video */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ATTACH_ACCEPT_TYPES}
        onChange={async (e) => {
          if (e.target.files) {
            await handleFileUpload(Array.from(e.target.files));
          }
          // Reset so the same file can be selected again
          e.target.value = '';
        }}
        className="hidden"
        multiple
      />

      {/* Hidden file input for audio/video files only (for transcription) */}
      <input
        ref={transcribeInputRef}
        type="file"
        accept={TRANSCRIPTION_ACCEPT_TYPES}
        onChange={async (e) => {
          if (e.target.files) {
            await handleFileUpload(Array.from(e.target.files));
          }
          // Reset so the same file can be selected again
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Hidden file input for documents (for translation) */}
      <input
        ref={documentTranslateInputRef}
        type="file"
        accept={DOCUMENT_TRANSLATION_ACCEPT_TYPES}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setDocumentToTranslate(file);
            setIsDocumentTranslateOpen(true);
          }
          // Reset input so the same file can be selected again
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Document Translation Modal */}
      <ChatInputDocumentTranslate
        isOpen={isDocumentTranslateOpen}
        onClose={() => {
          setIsDocumentTranslateOpen(false);
          setDocumentToTranslate(null);
        }}
        documentFile={documentToTranslate}
        onTranslationComplete={handleDocumentTranslationComplete}
      />
    </div>
  );
};

export default Dropdown;
