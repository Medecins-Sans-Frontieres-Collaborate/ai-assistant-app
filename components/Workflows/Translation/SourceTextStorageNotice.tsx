'use client';

import { useTranslations } from 'next-intl';

import { StoredSourceText } from '@/client/hooks/workflows/useStoredSourceText';

import { RUN_RETENTION_DAYS } from '@/lib/utils/shared/translation/nativeRunStorage';

interface SourceTextStorageNoticeProps {
  storage: Pick<StoredSourceText, 'loading' | 'problem' | 'retry' | 'forget'>;
}

const TEXT = {
  missing: 'missing',
  'no-key': 'noKey',
  'other-key': 'otherKey',
  failed: 'failed',
} as const;

/**
 * Shown in the source pane while a source text kept in storage is being
 * fetched, or when it cannot be: expired, encrypted with a key this device
 * does not hold, or unreachable. Renders nothing otherwise.
 */
export function SourceTextStorageNotice({
  storage,
}: SourceTextStorageNoticeProps) {
  const t = useTranslations('workflows');
  if (storage.loading) {
    return (
      <p
        role="status"
        data-testid="source-text-loading"
        className="px-3 pt-2 text-xs text-gray-500 dark:text-gray-400"
      >
        {t('translation.sourceStorage.loading')}
      </p>
    );
  }
  if (!storage.problem) return null;
  const text = TEXT[storage.problem];
  const action =
    'rounded-md border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900';
  return (
    <div
      role="alert"
      data-testid="source-text-unavailable"
      className="mx-3 mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="font-medium">
        {t(`translation.sourceStorage.${text}Title`)}
      </p>
      <p className="mt-0.5">
        {t(`translation.sourceStorage.${text}Body`, {
          days: RUN_RETENTION_DAYS,
        })}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {storage.problem !== 'missing' && (
          <button type="button" onClick={storage.retry} className={action}>
            {t('translation.formatted.storage.retry')}
          </button>
        )}
        <button type="button" onClick={storage.forget} className={action}>
          {t('translation.sourceStorage.forget')}
        </button>
      </div>
    </div>
  );
}
