import {
  IconCheck,
  IconCopy,
  IconFileText,
  IconLoader2,
  IconRefresh,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import React, {
  FC,
  MouseEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';

import { Conversation, Message } from '@/types/chat';
import { Citation } from '@/types/rag';

import AudioPlayer from '@/components/Chat/AudioPlayer';
import { ThinkingBlock } from '@/components/Chat/ChatMessages/ThinkingBlock';
import { CitationList } from '@/components/Chat/Citations/CitationList';
import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';
import { StreamdownWithCodeButtons } from '@/components/Markdown/StreamdownWithCodeButtons';

import { ApiError } from '@/client/services';
import { useArtifactStore } from '@/client/stores/artifactStore';
import type { MermaidConfig } from 'mermaid';

interface AssistantMessageProps {
  content: string;
  message?: Message;
  copyOnClick: (event: MouseEvent<any>) => void;
  messageIsStreaming: boolean;
  messageIndex: number;
  selectedConversation: Conversation | null;
  messageCopied: boolean;
  onRegenerate?: () => void;
  children?: ReactNode; // Allow custom content (images, files, etc.)
}

export const AssistantMessage: FC<AssistantMessageProps> = ({
  content,
  message,
  copyOnClick,
  messageIsStreaming,
  messageIndex,
  selectedConversation,
  messageCopied,
  onRegenerate,
  children,
}) => {
  const t = useTranslations();
  const { openDocument } = useArtifactStore();
  const [processedContent, setProcessedContent] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [thinking, setThinking] = useState<string>('');
  const [isGeneratingAudio, setIsGeneratingAudio] = useState<boolean>(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);

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
    if (
      citationsData.length === 0 &&
      selectedConversation?.messages?.[messageIndex]?.citations
    ) {
      citationsData = deduplicateCitations(
        selectedConversation.messages[messageIndex].citations!,
      );
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

  const handleTTS = async () => {
    try {
      setIsGeneratingAudio(true);
      setLoadingMessage('Generating audio...');

      const response = await fetch('/api/chat/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: processedContent }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'TTS conversion failed');
      }

      setLoadingMessage('Processing audio...');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
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
  };

  // Close audio player and clean up resources
  const handleCloseAudio = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  };

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
    <div className="relative flex px-4 py-3 text-base lg:px-0 w-full">
      <div className="mt-[-2px] w-full">
        {loadingMessage && (
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-2 animate-pulse">
            {loadingMessage}
          </div>
        )}

        <div className="flex flex-col w-full">
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

          <div className="flex-1 w-full">
            {children || (
              <div
                className="prose dark:prose-invert max-w-none w-full"
                style={{ maxWidth: 'none' }}
              >
                <StreamdownWithCodeButtons>
                  <CitationStreamdown
                    citations={citations}
                    components={customMarkdownComponents}
                    isAnimating={messageIsStreaming}
                    controls={true}
                    shikiTheme={['github-light', 'github-dark']}
                    mermaidConfig={mermaidConfig}
                  >
                    {processedContent}
                  </CitationStreamdown>
                </StreamdownWithCodeButtons>
              </div>
            )}
          </div>

          {/* Citations - shown after content but before action buttons */}
          {citations.length > 0 && <CitationList citations={citations} />}

          {/* Action buttons at the bottom of the message - only show when not streaming */}
          {!messageIsStreaming && (
            <div className="flex items-center gap-2 mt-1">
              {/* Copy button */}
              <button
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
                onClick={copyOnClick}
                aria-label={messageCopied ? 'Copied' : 'Copy message'}
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
                  isGeneratingAudio
                    ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
                onClick={audioUrl ? handleCloseAudio : handleTTS}
                disabled={isGeneratingAudio}
                aria-label={
                  audioUrl
                    ? 'Stop audio'
                    : isGeneratingAudio
                      ? 'Generating audio...'
                      : 'Listen'
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

              {/* Open as document button */}
              <button
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
                onClick={() => {
                  openDocument(
                    processedContent,
                    'md',
                    'message.md',
                    'document',
                  );
                }}
                aria-label="Open as document"
                title="Open as document"
              >
                <IconFileText size={18} />
              </button>
            </div>
          )}

          {audioUrl && (
            <AudioPlayer audioUrl={audioUrl} onClose={handleCloseAudio} />
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
