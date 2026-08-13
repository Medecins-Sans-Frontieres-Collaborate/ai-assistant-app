import { IconArrowsExchange, IconRefresh, IconX } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

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
}) => {
  const t = useTranslations();

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

  return (
    <div className="absolute bottom-[160px] left-0 right-0 px-4 py-2">
      <div className="mx-auto max-w-3xl rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-900 dark:text-red-200 flex items-start justify-between">
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
    </div>
  );
};
