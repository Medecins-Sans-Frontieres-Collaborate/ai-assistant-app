import { IconRefresh, IconX } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

interface ChatErrorProps {
  error: string | null;
  onClearError: () => void;
  onRegenerate?: () => void;
  /** Re-sends the trailing user message; used when no assistant group exists. */
  onRetry?: () => void;
  canRegenerate?: boolean;
  /** True when a retry would succeed where regenerate wouldn't. */
  canRetry?: boolean;
}

/**
 * Renders error messages with dismiss + an action button. Prefers
 * `onRetry` when there's no assistant message to regenerate.
 */
export const ChatError: React.FC<ChatErrorProps> = ({
  error,
  onClearError,
  onRegenerate,
  onRetry,
  canRegenerate = false,
  canRetry = false,
}) => {
  const t = useTranslations();

  if (!error) return null;

  // Truncate so the card stays readable; full text stays on the title attr.
  const renderedError = (() => {
    if (error.length <= 280) return error;
    const firstPeriod = error.indexOf('.');
    if (firstPeriod > 0 && firstPeriod < 280) {
      return error.slice(0, firstPeriod + 1) + ' …';
    }
    return error.slice(0, 240).trimEnd() + ' …';
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

  return (
    <div className="absolute bottom-[160px] left-0 right-0 px-4 py-2">
      <div className="mx-auto max-w-3xl rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-900 dark:text-red-200 flex items-start justify-between">
        <span className="flex-1 whitespace-pre-wrap" title={error}>
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
