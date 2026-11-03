'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

interface AgentListStatusProps {
  pending: boolean;
  fetching: boolean;
  failed: boolean;
  /** Localized warning for a successful response with unavailable storage. */
  unavailableMessage?: string;
  onRetry: () => void;
}

/**
 * Distinguishes pending, failed and storage-unavailable admin listings from
 * genuinely empty lists. Retry is disabled while a request is in flight.
 * Returns no status for a healthy listing; cached rows may remain visible.
 */
export const AgentListStatus: FC<AgentListStatusProps> = ({
  pending,
  fetching,
  failed,
  unavailableMessage,
  onRetry,
}) => {
  const t = useTranslations('agentAccess');
  if (pending) {
    return (
      <p
        role="status"
        className="mb-3 text-sm text-gray-600 dark:text-gray-300"
      >
        {t('loading')}
      </p>
    );
  }
  if (!failed && !unavailableMessage) return null;
  return (
    <div
      role="alert"
      className="mb-3 text-sm text-amber-800 dark:text-amber-300"
    >
      <p className="max-w-prose">{unavailableMessage ?? t('loadError')}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={fetching}
        className="mt-2 min-h-11 rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {fetching ? t('loading') : t('retry')}
      </button>
    </div>
  );
};
