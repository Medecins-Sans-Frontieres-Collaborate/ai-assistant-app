'use client';

import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFileText,
  IconLanguage,
  IconLoader2,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';
import { useBlobTranscript } from '@/client/hooks/transcription/useBlobTranscript';

import { translateText } from '@/lib/services/translation/translationService';

import { getAutonym } from '@/lib/utils/app/locales';
import { generateAudioFilename } from '@/lib/utils/shared/string/slugify';

import { TRANSCRIPT_EXPIRY_DAYS } from '@/types/transcription';
import { MessageTranslationState } from '@/types/translation';

import AudioPlayer from '@/components/Chat/AudioPlayer';
import { TranslationDropdown } from '@/components/Chat/ChatMessages/TranslationDropdown';
import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';
import { StreamdownWithCodeButtons } from '@/components/Markdown/StreamdownWithCodeButtons';

import { useArtifactStore } from '@/client/stores/artifactStore';

interface TranscriptViewerProps {
  filename: string;
  transcript: string;
  processedContent?: string;
}

/**
 * Component for displaying audio/video transcripts with copy/download/translate/TTS functionality.
 * Translations use TranslationDropdown for consistency with AssistantMessage.
 */
export const TranscriptViewer: React.FC<TranscriptViewerProps> = ({
  filename,
  transcript,
  processedContent,
}) => {
  const t = useTranslations();
  const { openDocument } = useArtifactStore();
  const { ttsSettings } = useSettings();

  // UI state
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showTranslationDropdown, setShowTranslationDropdown] = useState(false);
  const translateButtonRef = useRef<HTMLButtonElement>(null);

  // Translation state (locale-keyed cache pattern, consistent with AssistantMessage)
  const [translationState, setTranslationState] =
    useState<MessageTranslationState>({
      currentLocale: null,
      isTranslating: false,
      translations: {},
      error: null,
    });

  // TTS state
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioSourceLocale, setAudioSourceLocale] = useState<string | null>(
    null,
  );
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);

  // Blob transcript loading via shared hook. Returns early (blobRef: null)
  // when `transcript` is inline content instead of a blob reference.
  const {
    blobRef,
    loadedContent: loadedTranscript,
    error: blobError,
    isLoading: isBlobLoading,
    pollCount,
    daysUntilExpiry,
    isExpired,
  } = useBlobTranscript(transcript, {
    fetchErrorMessage: t('transcription.fetchError'),
    expiredOrDeletedMessage: t('transcription.expiredOrDeleted'),
  });

  const showExpirationWarning =
    daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 2;

  // Clean up audio URL when component unmounts
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  // Determine currently displayed transcript
  // For blob references, use loadedTranscript; otherwise use transcript prop directly
  const displayedTranscript = useMemo(() => {
    const { currentLocale, translations } = translationState;
    if (currentLocale && translations[currentLocale]) {
      return translations[currentLocale].translatedText;
    }
    // If this is a blob reference, use loaded content; otherwise use prop directly
    return loadedTranscript ?? (blobRef ? '' : transcript);
  }, [transcript, translationState, loadedTranscript, blobRef]);

  // Get current view label (Original or language name)
  const currentViewLabel = useMemo(() => {
    if (!translationState.currentLocale) {
      return processedContent
        ? t('transcript.originalTranscript')
        : t('transcript.transcript');
    }
    return getAutonym(translationState.currentLocale);
  }, [processedContent, translationState.currentLocale, t]);

  // Set of cached locale codes (for TranslationDropdown)
  const cachedLocales = useMemo(() => {
    return new Set(Object.keys(translationState.translations));
  }, [translationState.translations]);

  // Generate contextual filename for audio downloads
  const audioDownloadFilename = useMemo(() => {
    return generateAudioFilename(filename, 'audio', 'mp3');
  }, [filename]);

  // Handle translation request (consistent with AssistantMessage pattern)
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
          sourceText: loadedTranscript ?? transcript,
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
        const errorMessage =
          error instanceof Error ? error.message : t('chat.translationError');
        setTranslationState((prev) => ({
          ...prev,
          isTranslating: false,
          error: errorMessage,
        }));
        // Auto-clear error after 3 seconds
        setTimeout(() => {
          setTranslationState((prev) => ({ ...prev, error: null }));
        }, 3000);
      }
    },
    [transcript, loadedTranscript, translationState.translations, t],
  );

  // TTS handler (consistent with AssistantMessage pattern)
  const handleTTS = useCallback(async () => {
    try {
      setIsGeneratingAudio(true);
      setLoadingMessage(t('chat.translating'));

      // Build request body with user's TTS settings for server-side voice resolution
      const requestBody = {
        text: displayedTranscript,
        rate: ttsSettings.rate,
        pitch: ttsSettings.pitch,
        outputFormat: ttsSettings.outputFormat,
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

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setAudioSourceLocale(translationState.currentLocale);
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
  }, [displayedTranscript, ttsSettings, translationState.currentLocale, t]);

  // Close audio player and clean up resources
  const handleCloseAudio = useCallback(() => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  }, [audioUrl]);

  // Open transcript as document
  const handleOpenAsDocument = useCallback(() => {
    const baseName = filename.replace(
      /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i,
      '',
    );
    openDocument(
      displayedTranscript,
      'txt',
      `${baseName}_transcript.txt`,
      'document',
    );
  }, [filename, displayedTranscript, openDocument]);

  // Copy uses currently displayed transcript
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(displayedTranscript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayedTranscript]);

  // Download uses currently displayed transcript
  const handleDownload = useCallback(() => {
    const suffix = translationState.currentLocale
      ? `_${translationState.currentLocale}`
      : '';
    const blob = new Blob([displayedTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename.replace(/\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i, '')}_transcript${suffix}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [displayedTranscript, filename, translationState.currentLocale]);

  // Format transcript with line breaks at sentence boundaries
  const formattedTranscript = displayedTranscript
    .replace(/([.!?])\s+/g, '$1\n\n')
    .trim();

  return (
    <div className="transcript-viewer my-4">
      {/* Header */}
      <div className="mb-3">
        {processedContent ? (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {t('transcript.transcriptionOf')}{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {filename}
            </span>
          </div>
        ) : (
          <div className="text-base font-medium text-gray-900 dark:text-gray-100">
            {t('transcript.transcriptionOf')} {filename}
          </div>
        )}
      </div>

      {/* Loading message */}
      {loadingMessage && (
        <div className="text-sm text-gray-500 dark:text-gray-400 mb-2 animate-pulse">
          {loadingMessage}
        </div>
      )}

      {/* Blob loading state */}
      {isBlobLoading && blobRef && (
        <div className="text-gray-500 dark:text-gray-400 mb-3">
          <div className="flex items-center gap-2">
            <IconLoader2 size={16} className="animate-spin" />
            <span className="animate-pulse">
              {t('transcription.loadingTranscript', {
                filename: blobRef.filename,
              })}
              {pollCount > 0 &&
                ` (${t('transcription.attempt')} ${pollCount + 1})`}
            </span>
          </div>
        </div>
      )}

      {/* Blob error state (expired or fetch failed) */}
      {(blobError || isExpired) && blobRef && (
        <div className="mb-3 rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {isExpired
              ? t('transcription.transcriptExpired', {
                  filename: blobRef.filename,
                  days: TRANSCRIPT_EXPIRY_DAYS,
                })
              : blobError}
          </p>
        </div>
      )}

      {/* Expiration warning for blob references */}
      {showExpirationWarning && blobRef && loadedTranscript && (
        <div className="mb-3 rounded-md border border-yellow-200 bg-yellow-50 p-2 dark:border-yellow-800 dark:bg-yellow-900/20">
          <p className="text-xs text-yellow-800 dark:text-yellow-200">
            {t('transcription.expirationWarning', {
              filename: blobRef.filename,
              days: daysUntilExpiry,
            })}
          </p>
        </div>
      )}

      {/* Translation indicator - shown when viewing translated content */}
      {translationState.currentLocale && (
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

      {/* Processed Content (if provided) */}
      {processedContent && (
        <div className="mb-4 prose dark:prose-invert max-w-none">
          <StreamdownWithCodeButtons>
            <CitationStreamdown
              citations={[]}
              isAnimating={false}
              controls={true}
              shikiTheme={['github-light', 'github-dark']}
            >
              {processedContent}
            </CitationStreamdown>
          </StreamdownWithCodeButtons>
        </div>
      )}

      {/* Transcript Box - only show when content is available */}
      {(!blobRef || (loadedTranscript && !blobError && !isExpired)) && (
        <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
            <div className="flex items-center gap-2">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
                {currentViewLabel}
              </div>
              {/* Translation loading indicator */}
              {translationState.isTranslating && (
                <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                  <IconLoader2 size={14} className="animate-spin" />
                  <span>{t('transcript.translating')}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Copy button */}
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                title={t('common.copyToClipboard')}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                {copied ? t('transcript.copied') : t('transcript.copy')}
              </button>

              {/* Download button */}
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                title={t('chat.downloadTranscript')}
              >
                <IconDownload size={14} />
                {t('transcript.download')}
              </button>

              {/* TTS button - hidden for blob transcripts (too long for TTS) */}
              {!blobRef && (
                <button
                  onClick={audioUrl ? handleCloseAudio : handleTTS}
                  disabled={isGeneratingAudio}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    isGeneratingAudio
                      ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                  title={
                    audioUrl
                      ? t('transcript.stopAudio')
                      : t('transcript.listen')
                  }
                >
                  {isGeneratingAudio ? (
                    <IconLoader2 size={14} className="animate-spin" />
                  ) : audioUrl ? (
                    <IconVolumeOff size={14} />
                  ) : (
                    <IconVolume size={14} />
                  )}
                </button>
              )}

              {/* Translate button */}
              <button
                ref={translateButtonRef}
                onClick={() =>
                  setShowTranslationDropdown(!showTranslationDropdown)
                }
                disabled={translationState.isTranslating}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  translationState.isTranslating
                    ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                    : translationState.currentLocale
                      ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
                title={t('chat.translateTranscript')}
              >
                {translationState.isTranslating ? (
                  <IconLoader2 size={14} className="animate-spin" />
                ) : (
                  <IconLanguage size={14} />
                )}
                {t('transcript.translate')}
              </button>

              {/* Open as document button */}
              <button
                onClick={handleOpenAsDocument}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                title={t('transcript.openAsDocument')}
              >
                <IconFileText size={14} />
              </button>

              {/* Expand/Collapse button (only when processedContent exists) */}
              {processedContent && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="ml-2 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                >
                  {expanded ? t('transcript.collapse') : t('transcript.expand')}
                </button>
              )}
            </div>
          </div>

          {/* Transcript Content */}
          {(!processedContent || expanded) && (
            <div
              className={`p-4 font-mono text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap overflow-y-auto ${
                processedContent ? 'max-h-96' : 'max-h-[600px]'
              }`}
            >
              {formattedTranscript}
            </div>
          )}

          {/* Collapsed state hint */}
          {processedContent && !expanded && (
            <div className="p-3 text-center text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800">
              {t('transcript.expandHint')}
            </div>
          )}
        </div>
      )}

      {/* Audio player */}
      {audioUrl && (
        <>
          {/* Indicator when audio source doesn't match displayed content */}
          {audioSourceLocale !== translationState.currentLocale && (
            <div className="text-xs text-amber-600 dark:text-amber-400 mt-2 mb-1 flex items-center gap-1">
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
          <div className="mt-2">
            <AudioPlayer
              audioUrl={audioUrl}
              onClose={handleCloseAudio}
              downloadFilename={audioDownloadFilename}
            />
          </div>
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
    </div>
  );
};
