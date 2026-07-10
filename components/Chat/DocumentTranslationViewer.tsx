'use client';

import {
  IconAlertTriangle,
  IconDownload,
  IconFileText,
  IconLanguage,
  IconLoader2,
} from '@tabler/icons-react';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { isAssistantMessageGroup } from '@/types/chat';
import { TRANSLATION_EXPIRY_DAYS } from '@/types/documentTranslation';

import { Tooltip } from '@/components/UI/Tooltip';

import { useConversationStore } from '@/client/stores/conversationStore';
import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';

/**
 * Regex to match document translation blob references.
 * Format: [Translation: filename | lang:code | blob:jobId | ext:extension | expires:ISO_TIMESTAMP]
 */
const TRANSLATION_REFERENCE_REGEX =
  /^\[Translation:\s*(.+?)\s*\|\s*lang:([a-zA-Z-]+)\s*\|\s*blob:([a-fA-F0-9-]+)\s*\|\s*ext:([a-zA-Z0-9]+)\s*\|\s*expires:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\]$/;

/**
 * Parsed document translation reference.
 */
interface TranslationReference {
  /** Translated filename */
  filename: string;
  /** Target language code */
  languageCode: string;
  /** Job/blob ID */
  jobId: string;
  /** File extension */
  extension: string;
  /** Expiration date */
  expiresAt: Date;
}

/**
 * Parses a document translation reference string.
 *
 * @param content - The content string to parse
 * @returns Parsed reference or null if not a valid reference
 */
export function parseTranslationReference(
  content: string,
): TranslationReference | null {
  const match = content.trim().match(TRANSLATION_REFERENCE_REGEX);
  if (!match) return null;
  return {
    filename: match[1],
    languageCode: match[2],
    jobId: match[3],
    extension: match[4],
    expiresAt: new Date(match[5]),
  };
}

/**
 * Checks if a content string is a document translation reference.
 *
 * @param content - The content string to check
 * @returns True if the content is a translation reference
 */
export function isDocumentTranslationReference(content: string): boolean {
  return TRANSLATION_REFERENCE_REGEX.test(content.trim());
}

/**
 * Pending marker for ASYNC (batch) translations — persisted as the assistant
 * message content while Azure processes the job, so the in-conversation
 * progress state survives reloads and resumes polling on mount. Rewritten to
 * the final [Translation: …] reference (or a failure line) when polling
 * resolves. Format:
 * [TranslationPending: filename | lang:code | job:jobId | ext:extension | submitted:ISO]
 */
const TRANSLATION_PENDING_REGEX =
  /^\[TranslationPending:\s*(.+?)\s*\|\s*lang:([a-zA-Z-]+)\s*\|\s*job:([a-fA-F0-9-]+)\s*\|\s*ext:([a-zA-Z0-9]+)\s*\|\s*submitted:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\]$/;

interface PendingTranslationReference {
  filename: string;
  languageCode: string;
  jobId: string;
  extension: string;
  submittedAt: Date;
}

export function parsePendingTranslationReference(
  content: string,
): PendingTranslationReference | null {
  const match = content.trim().match(TRANSLATION_PENDING_REGEX);
  if (!match) return null;
  return {
    filename: match[1],
    languageCode: match[2],
    jobId: match[3],
    extension: match[4],
    submittedAt: new Date(match[5]),
  };
}

export function isDocumentTranslationPendingReference(
  content: string,
): boolean {
  return TRANSLATION_PENDING_REGEX.test(content.trim());
}

export function formatPendingTranslationReference(
  filename: string,
  languageCode: string,
  jobId: string,
  extension: string,
  submittedAt: string,
): string {
  return `[TranslationPending: ${filename} | lang:${languageCode} | job:${jobId} | ext:${extension} | submitted:${submittedAt}]`;
}

/** Transcription-style polling backoff by elapsed time. */
function pendingPollInterval(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 2 * 60_000) return 5_000;
  if (elapsedMs < 10 * 60_000) return 15_000;
  return 30_000;
}

/**
 * Calculates days until expiration.
 */
function getDaysUntilExpiry(expiresAt: Date): number {
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Formats the translation reference for storage in message content.
 *
 * @param filename - Translated filename
 * @param languageCode - Target language code
 * @param jobId - Job/blob ID
 * @param extension - File extension
 * @param expiresAt - ISO timestamp string
 * @returns Formatted reference string
 */
export function formatTranslationReference(
  filename: string,
  languageCode: string,
  jobId: string,
  extension: string,
  expiresAt: string,
): string {
  return `[Translation: ${filename} | lang:${languageCode} | blob:${jobId} | ext:${extension} | expires:${expiresAt}]`;
}

/**
 * Rewrites the message that carries `pendingMarker` (across all
 * conversations — the user may have switched away) to `newContent`. Handles
 * both legacy assistant messages and assistant_group versions.
 */
function rewritePendingMessage(pendingMarker: string, newContent: string) {
  const { conversations, updateConversation } = useConversationStore.getState();
  for (const conversation of conversations) {
    let changed = false;
    const messages = conversation.messages.map((entry) => {
      if (isAssistantMessageGroup(entry)) {
        const versions = entry.versions.map((version) =>
          typeof version.content === 'string' &&
          version.content.trim() === pendingMarker
            ? ((changed = true), { ...version, content: newContent })
            : version,
        );
        return changed ? { ...entry, versions } : entry;
      }
      if (
        typeof entry.content === 'string' &&
        entry.content.trim() === pendingMarker
      ) {
        changed = true;
        return { ...entry, content: newContent };
      }
      return entry;
    });
    if (changed) {
      updateConversation(conversation.id, { messages });
      return;
    }
  }
}

/**
 * In-conversation progress card for an async (batch) translation. Polls the
 * status endpoint with backoff; on success rewrites this message's persisted
 * content to the final [Translation: …] reference (the regular viewer takes
 * over); on terminal failure rewrites to a plain error line. Because the
 * pending marker IS the message content, a reload simply remounts this view
 * and polling resumes.
 */
const PendingDocumentTranslation: FC<{
  pending: PendingTranslationReference;
  rawContent: string;
}> = ({ pending, rawContent }) => {
  const t = useTranslations();
  const [stalled, setStalled] = useState(false);

  const languageInfo = getDocumentTranslationLanguageByCode(
    pending.languageCode,
  );
  const languageDisplay = languageInfo
    ? `${languageInfo.nativeName} (${languageInfo.englishName})`
    : pending.languageCode;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const startedAt = pending.submittedAt.getTime() || Date.now();
    const marker = rawContent.trim();

    const finalize = (newContent: string, message?: string) => {
      rewritePendingMessage(marker, newContent);
      if (message) toast.success(message);
    };

    const poll = async () => {
      if (cancelled) return;
      try {
        const response = await fetch(
          `/api/document-translation/status/${pending.jobId}`,
        );
        if (response.status === 404) {
          // Job record expired/lost — terminal; the marker must not poll
          // forever across future reloads.
          finalize(
            t('documentTranslation.asyncFailed', {
              error: t('documentTranslation.jobNotFound'),
            }),
          );
          return;
        }
        if (response.ok) {
          consecutiveFailures = 0;
          const json = await response.json();
          const data = json.data ?? json;
          if (data.status === 'Succeeded' && data.reference) {
            finalize(
              formatTranslationReference(
                data.reference.translatedFilename,
                data.reference.targetLanguage,
                data.reference.jobId,
                data.reference.fileExtension,
                data.reference.expiresAt,
              ),
              t('documentTranslation.translationSuccess'),
            );
            return;
          }
          if (data.status === 'Failed') {
            finalize(
              t('documentTranslation.asyncFailed', {
                error: data.error ?? 'Unknown error',
              }),
            );
            toast.error(
              t('documentTranslation.asyncFailed', {
                error: data.error ?? 'Unknown error',
              }),
            );
            return;
          }
        } else {
          consecutiveFailures += 1;
        }
      } catch {
        consecutiveFailures += 1;
      }
      if (consecutiveFailures >= 15) {
        // Transient-failure ceiling: stop hammering, offer manual retry.
        setStalled(true);
        return;
      }
      timer = setTimeout(poll, pendingPollInterval(Date.now() - startedAt));
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Re-run only for a different job (or a manual retry after a stall).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.jobId, stalled]);

  return (
    <div className="my-4">
      <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <IconLoader2
              size={20}
              className="animate-spin text-blue-500 flex-shrink-0"
            />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {t('documentTranslation.pendingTitle', {
                  filename: pending.filename,
                })}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <IconLanguage size={14} className="text-indigo-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {t('documentTranslation.translatedTo', {
                    language: languageDisplay,
                  })}
                </span>
              </div>
            </div>
          </div>
          {stalled && (
            <button
              onClick={() => setStalled(false)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
            >
              {t('documentTranslation.retryPolling')}
            </button>
          )}
        </div>
        <div className="px-4 py-3 border-t border-gray-300 dark:border-gray-600">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {stalled
              ? t('documentTranslation.pollingStalled')
              : t('documentTranslation.pendingHint')}
          </p>
        </div>
      </div>
    </div>
  );
};

interface DocumentTranslationViewerProps {
  /** The translation reference content */
  content: string;
}

/**
 * Displays a translated document with download capability.
 */
export const DocumentTranslationViewer: FC<DocumentTranslationViewerProps> = ({
  content,
}) => {
  const t = useTranslations();
  const [isDownloading, setIsDownloading] = useState(false);

  // Parse the reference
  const reference = useMemo(
    () => parseTranslationReference(content),
    [content],
  );
  // Async (batch) translation still in flight → progress card with polling.
  const pending = useMemo(
    () => parsePendingTranslationReference(content),
    [content],
  );

  // Calculate expiration state
  const isExpired = reference
    ? getDaysUntilExpiry(reference.expiresAt) <= 0
    : false;
  const daysUntilExpiry = reference
    ? getDaysUntilExpiry(reference.expiresAt)
    : null;
  const showExpirationWarning =
    daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 2;

  // Get language info
  const languageInfo = reference
    ? getDocumentTranslationLanguageByCode(reference.languageCode)
    : null;
  const languageDisplay = languageInfo
    ? `${languageInfo.nativeName} (${languageInfo.englishName})`
    : reference?.languageCode || 'Unknown';
  const isUnofficialLanguage =
    !!languageInfo && !languageInfo.officiallySupported;

  // Handle download
  const handleDownload = useCallback(async () => {
    if (!reference || isExpired) return;

    setIsDownloading(true);

    try {
      const response = await fetch(
        `/api/document-translation/content/${reference.jobId}?filename=${encodeURIComponent(reference.filename)}&ext=${reference.extension}`,
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(t('documentTranslation.documentNotFound'));
        }
        throw new Error(t('documentTranslation.downloadFailed'));
      }

      // Get the blob and create download link
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = reference.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t('documentTranslation.downloadSuccess'));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(errorMessage);
      console.error('[DocumentTranslationViewer] Download error:', error);
    } finally {
      setIsDownloading(false);
    }
  }, [reference, isExpired, t]);

  // Async (batch) translation still in flight → progress card with polling.
  // (Placed after every hook — no conditional hook calls.)
  if (!reference && pending) {
    return (
      <PendingDocumentTranslation pending={pending} rawContent={content} />
    );
  }

  // If parsing failed, show error
  if (!reference) {
    return (
      <div className="my-4 p-4 border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 rounded-lg">
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('documentTranslation.invalidReference')}
        </p>
      </div>
    );
  }

  return (
    <div className="my-4">
      {/* Main container */}
      <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
        {/* Header with language badge */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
          <div className="flex items-center gap-3">
            <IconFileText size={20} className="text-blue-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {reference.filename}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <IconLanguage size={14} className="text-indigo-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {t('documentTranslation.translatedTo', {
                    language: languageDisplay,
                  })}
                </span>
                {isUnofficialLanguage && (
                  <Tooltip
                    content={t('documentTranslation.unofficialLanguageWarning')}
                    position="bottom"
                    multiline
                  >
                    <IconAlertTriangle
                      size={14}
                      className="text-amber-600 dark:text-amber-400"
                      aria-label={t('documentTranslation.unofficialBadgeLabel')}
                    />
                  </Tooltip>
                )}
              </div>
            </div>
          </div>

          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={isDownloading || isExpired}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              isDownloading || isExpired
                ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isDownloading ? (
              <>
                <IconLoader2 size={16} className="animate-spin" />
                {t('documentTranslation.downloading')}
              </>
            ) : (
              <>
                <IconDownload size={16} />
                {t('documentTranslation.download')}
              </>
            )}
          </button>
        </div>

        {/* Expiration info */}
        <div className="px-4 py-3">
          {isExpired ? (
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <IconAlertTriangle size={16} />
              <span className="text-sm">
                {t('documentTranslation.expired')}
              </span>
            </div>
          ) : showExpirationWarning ? (
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <IconAlertTriangle size={16} />
              <span className="text-sm">
                {t('documentTranslation.expiresSoon', {
                  days: daysUntilExpiry,
                })}
              </span>
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('documentTranslation.expires', {
                days: daysUntilExpiry || TRANSLATION_EXPIRY_DAYS,
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default DocumentTranslationViewer;
