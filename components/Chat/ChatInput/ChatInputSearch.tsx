import {
  IconBrandBing,
  IconLink,
  IconSearch,
  IconSettings,
} from '@tabler/icons-react';
import React, {
  Dispatch,
  SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import { AgentType } from '@/types/agent';
import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  FilePreview,
  ImageMessageContent,
  Message,
  MessageType,
} from '@/types/chat';

import crypto from 'crypto';

interface ChatInputSearchProps {
  isOpen: boolean; // Directly controls visibility
  onClose: () => void; // Callback to tell parent to close
  onFileUpload: (
    event: React.ChangeEvent<any> | File[] | FileList,
    setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
    setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
    setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>,
  ) => Promise<void>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>;
  setTextFieldValue: Dispatch<SetStateAction<string>>;
  initialMode?: 'search' | 'url';
  // New props for agent-based web search
  onSend?: (
    message: Message,
    forceStandardChat?: boolean,
    forcedAgentType?: AgentType,
  ) => void;
  setRequestStatusMessage?: Dispatch<SetStateAction<string | null>>;
  setProgress?: Dispatch<SetStateAction<number | null>>;
  stopConversationRef?: { current: boolean };
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
}

const ChatInputSearch = ({
  isOpen,
  onClose,
  onFileUpload,
  setSubmitType,
  setFilePreviews,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
  setTextFieldValue,
  initialMode = 'search',
  onSend,
  setRequestStatusMessage,
  setProgress,
  stopConversationRef,
  apiKey,
  systemPrompt,
  temperature,
}: ChatInputSearchProps) => {
  const t = useTranslations();

  const [mode, setMode] = useState<'search' | 'url'>(initialMode);

  // URL Mode States
  const [urlInput, setUrlInput] = useState('');
  const [urlQuestionInput, setUrlQuestionInput] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlStatusMessage, setUrlStatusMessage] = useState<string | null>(null);
  const [isUrlSubmitting, setIsUrlSubmitting] = useState<boolean>(false);

  // Search Mode States
  const [searchInput, setSearchInput] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchStatusMessage, setSearchStatusMessage] = useState<string | null>(
    null,
  );
  const [isSearchSubmitting, setIsSearchSubmitting] = useState<boolean>(false);

  const urlInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Reset mode if initialMode changes (e.g., modal re-opened with different mode by parent)
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    // Auto-populate question input when mode/primary input changes
    if (isOpen) {
      // Only if modal is intended to be open
      if (mode === 'url' && !urlQuestionInput && urlInput) {
        setUrlQuestionInput(t('defaultWebPullerQuestion'));
      }
    }
  }, [urlInput, mode, t, urlQuestionInput, isOpen]);

  // Focus input when modal opens or mode changes
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure the overlay is rendered
      setTimeout(() => {
        if (mode === 'url' && urlInputRef.current) {
          urlInputRef.current.focus();
        } else if (mode === 'search' && searchInputRef.current) {
          searchInputRef.current.focus();
        }
      }, 50);
    }
  }, [isOpen, mode]);

  const handleUrlSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUrlError(null);
    setUrlStatusMessage(t('webPullerPullingStatusMessage'));
    setIsUrlSubmitting(true);

    try {
      const response = await fetch('/api/v2/web/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput }),
      });
      if (!response.ok)
        throw new Error(
          t('errorFailedToFetchUrl') || 'Failed to fetch the URL content',
        );
      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const content = data.content;
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const blob = new Blob([content], { type: 'text/plain' });
      const urlHostname = new URL(urlInput).hostname;
      const fileName = `web-pull-${urlHostname}_${hash}.txt`;
      const file = new File([blob], fileName, { type: 'text/plain' });

      setUrlStatusMessage(t('webPullerHandlingContentStatusMessage'));
      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );
      setTextFieldValue(
        `${urlQuestionInput || t('defaultWebPullerQuestion')}\n\n${t(
          'webPullerCitationPrompt',
        )}: ${urlInput}\n\n${t('webPullerReferencePrompt')}`,
      );
      onClose();

      setUrlInput('');
      setUrlQuestionInput('');
    } catch (error: any) {
      console.error(error);
      setUrlError(error.message || t('chat.errorFetchingUrl'));
    } finally {
      setUrlStatusMessage(null);
      setIsUrlSubmitting(false);
    }
  };

  const handleSearchSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setSearchError(null);
    setIsSearchSubmitting(true);

    try {
      const originalQuery = searchInput;

      // Simply send the search query with forced web search agent
      // The parent component's agentic service will handle:
      // 1. Query optimization
      // 2. Agent execution
      // 3. Response generation with citations
      if (onSend) {
        const userMessage: Message = {
          role: 'user',
          content: originalQuery,
          messageType: MessageType.TEXT,
        };
        // Pass AgentType.WEB_SEARCH as forced agent to ensure web search is used
        onSend(userMessage, undefined, AgentType.WEB_SEARCH);
      }

      // Close modal and reset state
      onClose();
      setSearchInput('');
    } catch (error: any) {
      console.error(error);
      setSearchError(error.message || t('chat.errorInitiatingSearch'));
    } finally {
      setSearchStatusMessage(null);
      setIsSearchSubmitting(false);
    }
  };

  const isSubmitting = isUrlSubmitting || isSearchSubmitting;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isSubmitting) {
      e.preventDefault();
      if (mode === 'search') {
        if (searchInput.trim()) {
          handleSearchSubmit(e as any);
        }
      } else {
        if (urlInput.trim()) {
          handleUrlSubmit(e as any);
        }
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSubmit = () => {
    if (isSubmitting) return;

    if (mode === 'search' && searchInput.trim()) {
      const fakeEvent = { preventDefault: () => {} } as any;
      handleSearchSubmit(fakeEvent);
    } else if (mode === 'url' && urlInput.trim()) {
      const fakeEvent = { preventDefault: () => {} } as any;
      handleUrlSubmit(fakeEvent);
    }
  };

  const content = (
    <div className="w-full bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden">
      {/* Header with Close Button */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {mode === 'search' ? 'Search the Web' : 'Analyze URL'}
        </h2>
        <button
          onClick={onClose}
          className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          aria-label="Close"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Mode Toggle */}
      <div className="px-6 pt-4 pb-2">
        <div className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          <button
            onClick={() => setMode('search')}
            disabled={isSubmitting}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              mode === 'search'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <IconSearch className="w-4 h-4" />
              <span>Search</span>
            </div>
          </button>
          <button
            onClick={() => setMode('url')}
            disabled={isSubmitting}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              mode === 'url'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <IconLink className="w-4 h-4" />
              <span>URL</span>
            </div>
          </button>
        </div>
      </div>

      {/* Input Area */}
      <div className="px-6 py-4 space-y-3">
        {mode === 'search' ? (
          <div>
            <label
              htmlFor="search-term"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              What would you like to search for?
            </label>
            <input
              ref={searchInputRef}
              id="search-term"
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.enterSearchQueryPlaceholder')}
              disabled={isSubmitting}
              className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white bg-white dark:bg-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>
        ) : (
          <>
            <div>
              <label
                htmlFor="url-input"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                Enter URL to analyze
              </label>
              <input
                ref={urlInputRef}
                id="url-input"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="https://example.com"
                disabled={isSubmitting}
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white bg-white dark:bg-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label
                htmlFor="url-question-input"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                What would you like to know? (optional)
              </label>
              <input
                id="url-question-input"
                type="text"
                value={urlQuestionInput}
                onChange={(e) => setUrlQuestionInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('defaultWebPullerQuestion')}
                disabled={isSubmitting}
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white bg-white dark:bg-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </>
        )}

        {/* Error Messages */}
        {(searchError || urlError) && (
          <p className="text-red-500 text-sm" role="alert">
            {searchError || urlError}
          </p>
        )}
        {(searchStatusMessage || urlStatusMessage) && !isSubmitting && (
          <p className="text-gray-500 text-sm animate-pulse" aria-live="polite">
            {searchStatusMessage || urlStatusMessage}
          </p>
        )}
      </div>

      {/* Footer with Action Button */}
      <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Press Enter or click the button to{' '}
          {mode === 'search' ? 'search' : 'analyze'}
        </p>
        <button
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
            (mode === 'search' ? !searchInput.trim() : !urlInput.trim())
          }
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          {isSubmitting ? (
            <>
              <svg
                className="animate-spin h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span>Processing...</span>
            </>
          ) : (
            <>
              {mode === 'search' ? (
                <IconSearch className="w-4 h-4" />
              ) : (
                <IconLink className="w-4 h-4" />
              )}
              <span>{mode === 'search' ? 'Search' : 'Analyze'}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  if (!isOpen || typeof document === 'undefined') {
    return null; // Don't render anything if not open or on server
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-lg z-[99999] flex items-center justify-center p-4 animate-fade-in-fast"
      onClick={onClose}
      style={{ isolation: 'isolate' }}
    >
      {/* Search Container */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl animate-modal-in"
      >
        {content}
      </div>
    </div>,
    document.body,
  );
};

export default ChatInputSearch;
