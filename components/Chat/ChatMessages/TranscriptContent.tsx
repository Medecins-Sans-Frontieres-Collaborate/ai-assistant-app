'use client';

import { useTranslations } from 'next-intl';

import { useBlobTranscript } from '@/client/hooks/transcription/useBlobTranscript';

import { TRANSCRIPT_EXPIRY_DAYS } from '@/types/transcription';

interface TranscriptContentProps {
  /** The message content which may be inline text or a blob reference */
  content: string;
  /** Optional className for styling */
  className?: string;
}

/**
 * Component that renders transcript content.
 *
 * Handles two types of content:
 * 1. Inline transcripts: Renders the text directly
 * 2. Blob references: Polls API until content loads, with expiration warning
 */
export function TranscriptContent({
  content,
  className = '',
}: TranscriptContentProps) {
  const t = useTranslations('transcription');
  const {
    blobRef,
    loadedContent,
    error,
    isLoading,
    pollCount,
    daysUntilExpiry,
    isExpired,
  } = useBlobTranscript(content, {
    fetchErrorMessage: t('fetchError'),
    expiredOrDeletedMessage: t('expiredOrDeleted'),
  });

  // Inline content - render directly
  if (!blobRef) {
    return <div className={className}>{content}</div>;
  }

  const showWarning =
    daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 2;

  // Determine error message to display
  const displayError = isExpired
    ? t('transcriptExpired', {
        filename: blobRef.filename,
        days: TRANSCRIPT_EXPIRY_DAYS,
      })
    : error;

  // Loading state (with poll count indicator for long waits)
  if (isLoading) {
    return (
      <div className={`${className} text-gray-500 dark:text-gray-400`}>
        <div className="flex items-center gap-2">
          <span className="animate-pulse">
            {t('loadingTranscript', { filename: blobRef.filename })}
            {pollCount > 0 && ` (attempt ${pollCount + 1})`}
          </span>
        </div>
      </div>
    );
  }

  // Error state (expired or fetch failed)
  if (displayError) {
    return (
      <div className={`${className} text-gray-500 dark:text-gray-400`}>
        <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {displayError}
          </p>
        </div>
      </div>
    );
  }

  // Loaded content with optional expiration warning
  return (
    <div className={className}>
      {showWarning && (
        <div className="mb-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 dark:border-yellow-800 dark:bg-yellow-900/20">
          <p className="text-xs text-yellow-800 dark:text-yellow-200">
            {t('expirationWarning', {
              filename: blobRef.filename,
              days: daysUntilExpiry,
            })}
          </p>
        </div>
      )}
      <div className="whitespace-pre-wrap">
        [Transcript: {blobRef.filename}]{'\n'}
        {loadedContent}
      </div>
    </div>
  );
}

export default TranscriptContent;
