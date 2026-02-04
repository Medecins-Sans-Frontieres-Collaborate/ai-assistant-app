import {
  IconCheck,
  IconCopy,
  IconFileText,
  IconLanguage,
  IconLoader2,
  IconRefresh,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { translateText } from '@/lib/services/translation';

import { getAutonym } from '@/lib/utils/app/locales';
import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';
import { generateAudioFilename } from '@/lib/utils/shared/string/slugify';

import {
  Conversation,
  Message,
  VersionInfo,
  isAssistantMessageGroup,
} from '@/types/chat';
import { Citation } from '@/types/rag';
import { MessageTranslationState } from '@/types/translation';
import { TTSSettings } from '@/types/tts';

import AudioPlayer from '@/components/Chat/AudioPlayer';
import { DocumentTranslationContent } from '@/components/Chat/ChatMessages/DocumentTranslationContent';
import { ThinkingBlock } from '@/components/Chat/ChatMessages/ThinkingBlock';
import { TranscriptContent } from '@/components/Chat/ChatMessages/TranscriptContent';
import { TranslationDropdown } from '@/components/Chat/ChatMessages/TranslationDropdown';
import { VersionNavigation } from '@/components/Chat/ChatMessages/VersionNavigation';
import { CitationList } from '@/components/Chat/Citations/CitationList';
import { TTSContextMenu } from '@/components/Chat/TTS/TTSContextMenu';
import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';
import { StreamdownWithCodeButtons } from '@/components/Markdown/StreamdownWithCodeButtons';

import { useArtifactStore } from '@/client/stores/artifactStore';
import type { MermaidConfig } from 'mermaid';

/**
 * Checks if content is a blob transcript reference that should be loaded from storage.
 * Format: [Transcript: filename | blob:jobId | expires:ISO_TIMESTAMP]
 */
function isBlobTranscriptReference(content: string): boolean {
  return /^\[Transcript:\s*.+?\s*\|\s*blob:[a-fA-F0-9-]+\s*\|\s*expires:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]$/.test(
    content.trim(),
  );
}

/**
 * Checks if content is a document translation reference.
 * Format: [Translation: filename | lang:code | blob:jobId | ext:extension | expires:ISO_TIMESTAMP]
 */
function isDocumentTranslationReference(content: string): boolean {
  return /^\[Translation:\s*.+?\s*\|\s*lang:[a-zA-Z-]+\s*\|\s*blob:[a-fA-F0-9-]+\s*\|\s*ext:[a-zA-Z0-9]+\s*\|\s*expires:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]$/.test(
    content.trim(),
  );
}

interface AssistantMessageProps {
  content: string;
  message?: Message;
  messageIsStreaming: boolean;
  messageIndex: number;
  selectedConversation: Conversation | null;
  onRegenerate?: () => void;
  children?: ReactNode; // Allow custom content (images, files, etc.)
  // Version navigation props
  versionInfo?: VersionInfo | null;
  onPreviousVersion?: () => void;
  onNextVersion?: () => void;
}

export const AssistantMessage: FC<AssistantMessageProps> = ({
  content,
  message,
  messageIsStreaming,
  messageIndex,
  selectedConversation,
  onRegenerate,
  children,
  versionInfo,
  onPreviousVersion,
  onNextVersion,
}) => {
  const t = useTranslations();
  const { openDocument } = useArtifactStore();
  const { ttsSettings } = useSettings();
  const [processedContent, setProcessedContent] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [thinking, setThinking] = useState<string>('');
  const [isGeneratingAudio, setIsGeneratingAudio] = useState<boolean>(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioSourceLocale, setAudioSourceLocale] = useState<string | null>(
    null,
  ); // Tracks which locale audio was generated for (null = original)
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const [messageCopied, setMessageCopied] = useState(false);

  // TTS context menu state
  const [ttsContextMenu, setTTSContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Translation state
  const [translationState, setTranslationState] =
    useState<MessageTranslationState>({
      currentLocale: null,
      isTranslating: false,
      translations: {},
      error: null,
    });
  const [showTranslationDropdown, setShowTranslationDropdown] = useState(false);
  const translateButtonRef = useRef<HTMLButtonElement>(null);

  // Detect if embedded content is present (e.g., TranscriptViewer)
  // When children is provided, content-specific actions should be disabled
  // since the child component handles its own actions
  const hasEmbeddedContent = !!children;

  // Detect dark mode
  useEffect(() => {
    const updateTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setIsDarkMode(isDark);
    };

    updateTheme();

    // Watch for theme changes
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  // Reset audio state when conversation changes
  useEffect(() => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setAudioSourceLocale(null);
    setIsGeneratingAudio(false);
    setLoadingMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation?.id]);

  // Process content once per change - simplified logic
  useEffect(() => {
    // Parse thinking content from the raw content
    const { thinking: inlineThinking, content: contentWithoutThinking } =
      parseThinkingContent(content);

    let mainContent = contentWithoutThinking;
    let citationsData: Citation[] = [];
    let metadataThinking = '';

    // Priority 1: Citations from message object (already processed)
    if (message?.citations && message.citations.length > 0) {
      citationsData = message.citations;
    }
    // Priority 2: Parse metadata format (new approach)
    else {
      const metadataMatch = contentWithoutThinking.match(
        /\n\n<<<METADATA_START>>>(.*?)<<<METADATA_END>>>/s,
      );
      if (metadataMatch) {
        mainContent = contentWithoutThinking.replace(
          /\n\n<<<METADATA_START>>>.*?<<<METADATA_END>>>/s,
          '',
        );

        try {
          const parsedData = JSON.parse(metadataMatch[1]);
          if (parsedData.citations) {
            citationsData = deduplicateCitations(parsedData.citations);
          }
          if (parsedData.thinking) {
            metadataThinking = parsedData.thinking;
          }
        } catch (error) {
          // Silently ignore parsing errors during streaming
        }
      }
      // Priority 3: Legacy JSON at end (only when not streaming)
      else if (!messageIsStreaming) {
        const jsonMatch = contentWithoutThinking.match(/(\{[\s\S]*\})$/);
        if (jsonMatch && isValidJSON(jsonMatch[1])) {
          // Don't use .trim() - it removes newlines needed for markdown
          mainContent = contentWithoutThinking.slice(0, -jsonMatch[1].length);
          try {
            const parsedData = JSON.parse(jsonMatch[1].trim());
            if (parsedData.citations) {
              citationsData = deduplicateCitations(parsedData.citations);
            }
          } catch (error) {
            // Silently ignore parsing errors
          }
        }
      }
    }

    // Priority 4: Fallback to conversation-stored citations
    // Handle both legacy messages and assistant message groups
    if (citationsData.length === 0 && selectedConversation?.messages) {
      const entry = selectedConversation.messages[messageIndex];
      if (entry) {
        let storedCitations: Citation[] | undefined;
        if (isAssistantMessageGroup(entry)) {
          storedCitations = entry.versions[entry.activeIndex]?.citations;
        } else if ('citations' in entry) {
          storedCitations = entry.citations;
        }
        if (storedCitations) {
          citationsData = deduplicateCitations(storedCitations);
        }
      }
    }

    // Determine final thinking content (priority: message > metadata > inline)
    const finalThinking =
      message?.thinking || metadataThinking || inlineThinking || '';

    setProcessedContent(mainContent);
    setThinking(finalThinking);
    setCitations(citationsData);
  }, [
    content,
    message,
    messageIsStreaming,
    messageIndex,
    selectedConversation?.messages,
  ]);

  // Displayed content (original or translated) - must be declared before handlers that use it
  const displayedContent = useMemo(() => {
    const { currentLocale, translations } = translationState;
    if (currentLocale && translations[currentLocale]) {
      return translations[currentLocale].translatedText;
    }
    return processedContent;
  }, [translationState, processedContent]);

  // Generate contextual filename for audio downloads (1-indexed for human readability)
  const audioDownloadFilename = useMemo(() => {
    return generateAudioFilename(
      selectedConversation?.name || '',
      messageIndex + 1,
      'mp3',
      'assistant-audio',
    );
  }, [selectedConversation?.name, messageIndex]);

  // Copy handler - uses displayed content (original or translated)
  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;

    navigator.clipboard.writeText(displayedContent).then(() => {
      setMessageCopied(true);
      setTimeout(() => {
        setMessageCopied(false);
      }, 2000);
    });
  }, [displayedContent]);

  const handleTTS = useCallback(
    async (overrides: Partial<TTSSettings> = {}) => {
      try {
        setIsGeneratingAudio(true);
        setLoadingMessage('Generating audio...');

        // Build request body with user's TTS settings for server-side voice resolution
        // Send explicit voice override if provided, otherwise send settings for resolution
        const requestBody = {
          text: displayedContent,
          voiceName: overrides.globalVoice || undefined,
          rate: overrides.rate ?? ttsSettings.rate,
          pitch: overrides.pitch ?? ttsSettings.pitch,
          outputFormat: overrides.outputFormat ?? ttsSettings.outputFormat,
          globalVoice: ttsSettings.globalVoice,
          languageVoices: ttsSettings.languageVoices,
        };

        const response = await fetch('/api/chat/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'TTS conversion failed');
        }

        setLoadingMessage('Processing audio...');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setAudioSourceLocale(translationState.currentLocale); // Track which locale audio was generated for
        setIsGeneratingAudio(false);
        setLoadingMessage(null);
      } catch (error) {
        console.error('Error in TTS:', error);
        setIsGeneratingAudio(false);
        const message =
          error instanceof Error
            ? error.message
            : 'Error generating audio. Please try again.';
        setLoadingMessage(message);
        setTimeout(() => setLoadingMessage(null), 3000);
      }
    },
    [displayedContent, ttsSettings, translationState.currentLocale],
  );

  // Close audio player and clean up resources
  const handleCloseAudio = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  };

  // Translation handler
  const handleTranslate = useCallback(
    async (targetLocale: string | null) => {
      // Reset to original
      if (targetLocale === null) {
        setTranslationState((prev) => ({
          ...prev,
          currentLocale: null,
          error: null,
        }));
        return;
      }

      // Check cache first
      if (translationState.translations[targetLocale]) {
        setTranslationState((prev) => ({
          ...prev,
          currentLocale: targetLocale,
          error: null,
        }));
        return;
      }

      // Call API for new translation
      setTranslationState((prev) => ({
        ...prev,
        isTranslating: true,
        error: null,
      }));

      try {
        const response = await translateText({
          sourceText: processedContent,
          targetLocale,
        });

        if (response.success && response.data) {
          setTranslationState((prev) => ({
            ...prev,
            currentLocale: targetLocale,
            isTranslating: false,
            translations: {
              ...prev.translations,
              [targetLocale]: {
                locale: targetLocale,
                translatedText: response.data!.translatedText,
                notes: response.data!.notes,
                cachedAt: Date.now(),
              },
            },
          }));
        } else {
          throw new Error(response.error || 'Translation failed');
        }
      } catch (error) {
        console.error('Translation error:', error);
        setTranslationState((prev) => ({
          ...prev,
          isTranslating: false,
          error: error instanceof Error ? error.message : 'Translation failed',
        }));
        // Clear error after 3 seconds
        setTimeout(() => {
          setTranslationState((prev) => ({ ...prev, error: null }));
        }, 3000);
      }
    },
    [processedContent, translationState.translations],
  );

  // Set of cached locale codes
  const cachedLocales = useMemo(() => {
    return new Set(Object.keys(translationState.translations));
  }, [translationState.translations]);

  // Custom components for Streamdown
  // Note: Streamdown handles code highlighting (Shiki), Mermaid, and math (KaTeX) built-in
  const customMarkdownComponents = {};

  // Mermaid configuration with dark mode support
  const mermaidConfig: MermaidConfig = {
    startOnLoad: false,
    theme: isDarkMode ? 'dark' : 'default',
    themeVariables: isDarkMode
      ? {
          // Dark mode colors - make everything visible on dark background
          primaryColor: '#3b82f6',
          primaryTextColor: '#e5e7eb',
          primaryBorderColor: '#60a5fa',
          lineColor: '#9ca3af',
          secondaryColor: '#1e293b',
          tertiaryColor: '#0f172a',
          background: '#1f2937',
          mainBkg: '#1f2937',
          secondBkg: '#111827',
          textColor: '#f3f4f6',
          border1: '#4b5563',
          border2: '#6b7280',
          arrowheadColor: '#e5e7eb', // White arrows
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '14px',
          // Sequence diagram specific
          actorTextColor: '#f3f4f6',
          actorLineColor: '#9ca3af',
          signalColor: '#e5e7eb',
          signalTextColor: '#f3f4f6',
          labelBoxBkgColor: '#374151',
          labelBoxBorderColor: '#6b7280',
          labelTextColor: '#f3f4f6',
          loopTextColor: '#f3f4f6',
          activationBorderColor: '#60a5fa',
          activationBkgColor: '#1e3a8a',
          sequenceNumberColor: '#ffffff',
        }
      : {
          // Light mode colors
          primaryColor: '#3b82f6',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '14px',
        },
    logLevel: 'error', // Only log errors, don't crash
    securityLevel: 'loose', // More lenient parsing
    suppressErrorRendering: true, // Hide error messages from UI
  };

  return (
    <div
      className="relative flex px-4 py-3 text-base lg:px-0"
      style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
    >
      <div
        className="mt-[-2px]"
        style={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {loadingMessage && (
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-2 animate-pulse">
            {loadingMessage}
          </div>
        )}

        <div
          className="flex flex-col"
          style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
        >
          {/* Thinking block - displayed before main content */}
          {thinking && (
            <ThinkingBlock
              thinking={thinking}
              isStreaming={messageIsStreaming && !processedContent}
            />
          )}

          {/* Try Again button for failed messages */}
          {message?.error && onRegenerate && (
            <div className="mb-4">
              <button
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium transition-colors"
                onClick={onRegenerate}
                aria-label={t('common.tryAgain')}
              >
                <IconRefresh size={18} />
                Try Again
              </button>
            </div>
          )}

          {/* Translation indicator - shown when viewing translated content */}
          {translationState.currentLocale && !messageIsStreaming && (
            <div className="flex items-center gap-2 mb-2 text-sm text-blue-600 dark:text-blue-400">
              <IconLanguage size={14} />
              <span>
                {t('chat.translatedTo', {
                  language: getAutonym(translationState.currentLocale),
                })}
              </span>
              <button
                onClick={() => handleTranslate(null)}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('chat.showOriginal')}
              </button>
            </div>
          )}

          {/* Translation error */}
          {translationState.error && (
            <div className="text-sm text-red-500 dark:text-red-400 mb-2">
              {translationState.error}
            </div>
          )}

          <div className="flex-1 w-full">
            {children || (
              <div
                className="prose dark:prose-invert max-w-none w-full"
                style={{ maxWidth: 'none' }}
              >
                {/* Check for document translation reference */}
                {isDocumentTranslationReference(displayedContent) ? (
                  <DocumentTranslationContent content={displayedContent} />
                ) : /* Check if content is a blob transcript reference that needs lazy loading */
                isBlobTranscriptReference(displayedContent) ? (
                  <TranscriptContent
                    content={displayedContent}
                    className="whitespace-pre-wrap"
                  />
                ) : (
                  <StreamdownWithCodeButtons>
                    <CitationStreamdown
                      citations={citations}
                      components={customMarkdownComponents}
                      isAnimating={messageIsStreaming}
                      controls={true}
                      shikiTheme={['github-light', 'github-dark']}
                      mermaid={{ config: mermaidConfig }}
                    >
                      {displayedContent}
                    </CitationStreamdown>
                  </StreamdownWithCodeButtons>
                )}
              </div>
            )}
          </div>

          {/* Citations - shown after content but before action buttons */}
          {citations.length > 0 && <CitationList citations={citations} />}

          {/* Action buttons at the bottom of the message - only show when not streaming */}
          {!messageIsStreaming && (
            <div className="flex items-center gap-2 mt-1">
              {/* Version navigation - placed before other actions */}
              {versionInfo?.hasMultiple &&
                onPreviousVersion &&
                onNextVersion && (
                  <VersionNavigation
                    currentVersion={versionInfo.current}
                    totalVersions={versionInfo.total}
                    onPrevious={onPreviousVersion}
                    onNext={onNextVersion}
                  />
                )}

              {/* Copy button */}
              <button
                className={`transition-colors ${
                  hasEmbeddedContent
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
                onClick={hasEmbeddedContent ? undefined : handleCopy}
                disabled={hasEmbeddedContent}
                aria-label={messageCopied ? 'Copied' : 'Copy message'}
                title={
                  hasEmbeddedContent
                    ? t('chat.actionsDisabledForEmbed')
                    : undefined
                }
              >
                {messageCopied ? (
                  <IconCheck size={18} />
                ) : (
                  <IconCopy size={18} />
                )}
              </button>

              {/* Regenerate button */}
              {onRegenerate && (
                <button
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
                  onClick={onRegenerate}
                  aria-label={t('chat.regenerateResponse')}
                >
                  <IconRefresh size={18} />
                </button>
              )}

              {/* Listen button */}
              <button
                className={`transition-colors ${
                  hasEmbeddedContent
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : isGeneratingAudio
                      ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
                onClick={
                  hasEmbeddedContent
                    ? undefined
                    : audioUrl
                      ? handleCloseAudio
                      : () => handleTTS()
                }
                onContextMenu={(e) => {
                  if (!hasEmbeddedContent && !isGeneratingAudio && !audioUrl) {
                    e.preventDefault();
                    setTTSContextMenu({ x: e.clientX, y: e.clientY });
                  }
                }}
                disabled={hasEmbeddedContent || isGeneratingAudio}
                aria-label={
                  audioUrl
                    ? 'Stop audio'
                    : isGeneratingAudio
                      ? 'Generating audio...'
                      : 'Listen'
                }
                title={
                  hasEmbeddedContent
                    ? t('chat.actionsDisabledForEmbed')
                    : t('chat.ttsRightClickHint')
                }
              >
                {isGeneratingAudio ? (
                  <IconLoader2 size={18} className="animate-spin" />
                ) : audioUrl ? (
                  <IconVolumeOff size={18} />
                ) : (
                  <IconVolume size={18} />
                )}
              </button>

              {/* Translate button */}
              <button
                ref={translateButtonRef}
                className={`transition-colors ${
                  hasEmbeddedContent
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : translationState.isTranslating
                      ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                      : translationState.currentLocale
                        ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
                        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
                onClick={
                  hasEmbeddedContent
                    ? undefined
                    : () => setShowTranslationDropdown(!showTranslationDropdown)
                }
                disabled={hasEmbeddedContent || translationState.isTranslating}
                aria-label={t('chat.translateMessage')}
                title={
                  hasEmbeddedContent
                    ? t('chat.actionsDisabledForEmbed')
                    : t('chat.translateMessage')
                }
              >
                {translationState.isTranslating ? (
                  <IconLoader2 size={18} className="animate-spin" />
                ) : (
                  <IconLanguage size={18} />
                )}
              </button>

              {/* Open as document button */}
              <button
                className={`transition-colors ${
                  hasEmbeddedContent
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
                onClick={
                  hasEmbeddedContent
                    ? undefined
                    : () => {
                        openDocument(
                          displayedContent,
                          'md',
                          'message.md',
                          'document',
                        );
                      }
                }
                disabled={hasEmbeddedContent}
                aria-label="Open as document"
                title={
                  hasEmbeddedContent
                    ? t('chat.actionsDisabledForEmbed')
                    : 'Open as document'
                }
              >
                <IconFileText size={18} />
              </button>
            </div>
          )}

          {audioUrl && (
            <>
              {/* Indicator when audio source doesn't match displayed content */}
              {audioSourceLocale !== translationState.currentLocale && (
                <div className="text-xs text-amber-600 dark:text-amber-400 mb-1 flex items-center gap-1">
                  <IconVolume size={12} />
                  <span>
                    {audioSourceLocale
                      ? t('chat.audioFromTranslation', {
                          language: getAutonym(audioSourceLocale),
                        })
                      : t('chat.audioFromOriginal')}
                  </span>
                </div>
              )}
              <AudioPlayer
                audioUrl={audioUrl}
                onClose={handleCloseAudio}
                downloadFilename={audioDownloadFilename}
              />
            </>
          )}

          {/* Translation dropdown */}
          <TranslationDropdown
            triggerRef={translateButtonRef}
            isOpen={showTranslationDropdown}
            onClose={() => setShowTranslationDropdown(false)}
            onSelectLanguage={handleTranslate}
            currentLocale={translationState.currentLocale}
            isTranslating={translationState.isTranslating}
            cachedLocales={cachedLocales}
          />

          {/* TTS Context Menu */}
          {ttsContextMenu && (
            <TTSContextMenu
              position={ttsContextMenu}
              onClose={() => setTTSContextMenu(null)}
              onTriggerTTS={(overrides) => {
                setTTSContextMenu(null);
                handleTTS(overrides);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// Helper function to deduplicate citations by URL or title
function deduplicateCitations(citations: Citation[]): Citation[] {
  const uniqueCitationsMap = new Map();
  citations.forEach((citation: Citation) => {
    const key = citation.url || citation.title;
    if (key && !uniqueCitationsMap.has(key)) {
      uniqueCitationsMap.set(key, citation);
    }
  });
  return Array.from(uniqueCitationsMap.values());
}

// Helper function to validate JSON structure
function isValidJSON(jsonStr: string): boolean {
  const trimmed = jsonStr.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  const openBraces = (trimmed.match(/{/g) || []).length;
  const closeBraces = (trimmed.match(/}/g) || []).length;
  return openBraces === closeBraces;
}

export default AssistantMessage;
