import {
  IconArrowsExchange,
  IconDownload,
  IconMessagePlus,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import React, { useState } from 'react';

import { useTranslations } from 'next-intl';

import { REPEATED_FAILURE_THRESHOLD } from '@/client/stores/chatStore';

interface ChatErrorProps {
  error: string | null;
  /**
   * Structured server error code for `error`, when one was reported.
   * Code-specific failures (e.g. FILE_NOT_FOUND for an expired attachment)
   * render localized copy instead of the raw server string.
   */
  errorCode?: string | null;
  onClearError: () => void;
  onRegenerate?: () => void;
  /** Re-sends the trailing user message; used when no assistant group exists. */
  onRetry?: () => void;
  canRegenerate?: boolean;
  /** True when a retry would succeed where regenerate wouldn't. */
  canRetry?: boolean;
  /** Re-sends the failed turn on the next fallback-chain model. */
  onRetryFallback?: () => void;
  canRetryFallback?: boolean;
  /** Display name of the fallback model the retry would use. */
  fallbackModelName?: string | null;
  /**
   * Consecutive identical failures for the conversation behind this banner
   * (0 when none). At REPEATED_FAILURE_THRESHOLD the card escalates:
   * corrupted-conversation notice + start-new + debug-download actions.
   */
  failureStreakCount?: number;
  /** Spawns and selects a fresh conversation (current model carried over). */
  onStartNewConversation?: () => void;
  /** Downloads the debug bundle; `includeContent` = full message text. */
  onDownloadDebugInfo?: (includeContent: boolean) => void;
}

/**
 * Renders error messages with dismiss + action buttons. Prefers `onRetry`
 * when there's no assistant message to regenerate; additionally offers a
 * "try with <fallback model>" action when the failed turn's model has a
 * fallback available — the manual counterpart of the store's automatic
 * fallback, for failures it deliberately never retries silently (e.g. a
 * stream that died mid-response).
 */
export const ChatError: React.FC<ChatErrorProps> = ({
  error,
  errorCode,
  onClearError,
  onRegenerate,
  onRetry,
  canRegenerate = false,
  canRetry = false,
  onRetryFallback,
  canRetryFallback = false,
  fallbackModelName,
  failureStreakCount = 0,
  onStartNewConversation,
  onDownloadDebugInfo,
}) => {
  const t = useTranslations();
  // Privacy default: the debug bundle is metadata-only unless the user
  // explicitly opts message text in.
  const [includeMessageText, setIncludeMessageText] = useState(false);

  if (!error) return null;

  // The store keeps the raw (English) server message; localized copy for
  // known codes is owned here, where translations are available.
  const effectiveError =
    errorCode === 'FILE_NOT_FOUND' ? t('chat.attachedFileExpired') : error;

  // Truncate so the card stays readable; full text stays on the title attr.
  const renderedError = (() => {
    if (effectiveError.length <= 280) return effectiveError;
    const firstPeriod = effectiveError.indexOf('.');
    if (firstPeriod > 0 && firstPeriod < 280) {
      return effectiveError.slice(0, firstPeriod + 1) + ' …';
    }
    return effectiveError.slice(0, 240).trimEnd() + ' …';
  })();

  const showRetry = canRetry && onRetry;
  const showRegenerate = !showRetry && canRegenerate && onRegenerate;
  const actionLabel = showRetry
    ? t('common.tryAgain')
    : showRegenerate
      ? t('chat.regenerate')
      : null;
  const onActionClick = showRetry
    ? onRetry
    : showRegenerate
      ? onRegenerate
      : null;
  const showRetryFallback =
    canRetryFallback && onRetryFallback && !!fallbackModelName;
  const showEscalation =
    failureStreakCount >= REPEATED_FAILURE_THRESHOLD &&
    !!onStartNewConversation &&
    !!onDownloadDebugInfo;

  return (
    <div className="absolute bottom-[160px] left-0 right-0 px-4 py-2">
      <div className="mx-auto max-w-3xl rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-900 dark:text-red-200">
        <div className="flex items-start justify-between">
          <span className="flex-1 whitespace-pre-wrap" title={effectiveError}>
            {renderedError}
          </span>
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            {actionLabel && onActionClick && (
              <button
                onClick={onActionClick}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
                aria-label={actionLabel}
              >
                <IconRefresh size={16} />
                <span>{actionLabel}</span>
              </button>
            )}
            {showRetryFallback && (
              <button
                onClick={onRetryFallback}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
                aria-label={t('chat.retryWithModel', {
                  model: fallbackModelName,
                })}
              >
                <IconArrowsExchange size={16} />
                <span>
                  {t('chat.retryWithModel', { model: fallbackModelName })}
                </span>
              </button>
            )}
            <button
              onClick={onClearError}
              className="text-red-800 dark:text-red-200 hover:text-red-600 dark:hover:text-red-100 transition-colors"
              aria-label={t('errors.dismissError')}
            >
              <IconX size={20} />
            </button>
          </div>
        </div>
        {showEscalation && (
          <div className="mt-3 border-t border-red-300 dark:border-red-700 pt-3">
            <p className="text-sm">{t('chat.repeatedFailureNotice')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                onClick={onStartNewConversation}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconMessagePlus size={16} />
                <span>{t('chat.startNewConversation')}</span>
              </button>
              <button
                onClick={() => onDownloadDebugInfo?.(includeMessageText)}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconDownload size={16} />
                <span>{t('chat.downloadDebugInfo')}</span>
              </button>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeMessageText}
                  onChange={(e) => setIncludeMessageText(e.target.checked)}
                  className="accent-red-700 dark:accent-red-400"
                />
                {t('chat.includeMessageText')}
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
