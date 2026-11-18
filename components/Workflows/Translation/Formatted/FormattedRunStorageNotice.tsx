'use client';

import { IconCloud, IconLock } from '@tabler/icons-react';

import { useLocale, useTranslations } from 'next-intl';

import { FormattedRunProblem } from '@/client/hooks/workflows/useFormattedRunStorage';

import {
  NativeRunRef,
  RUN_RETENTION_DAYS,
  runDaysLeft,
  runExpiryState,
} from '@/lib/utils/shared/translation/nativeRunStorage';

const PRIMARY =
  'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const SECONDARY =
  'rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-surface-dark-elevated';

interface FormattedRunUnavailableProps {
  /** Why the run cannot be shown; null while it is being loaded. */
  problem: FormattedRunProblem | null;
  /** Tries loading again. */
  onRetry: () => void;
  /** Forgets the run so the document can be translated again. */
  onStartOver: () => void;
}

/**
 * Shown in place of a formatted translation that is being read from
 * storage, or cannot be: expired, encrypted with a key this device does
 * not hold, or unreachable.
 */
export function FormattedRunUnavailable({
  problem,
  onRetry,
  onStartOver,
}: FormattedRunUnavailableProps) {
  const t = useTranslations('workflows');
  if (!problem) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center px-5 py-10 text-sm text-gray-500 dark:text-gray-400"
      >
        {t('translation.formatted.storage.loading')}
      </div>
    );
  }
  const text = {
    missing: 'missing',
    'no-key': 'noKey',
    'other-key': 'otherKey',
    failed: 'failed',
  }[problem];
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-5 py-10">
      <div
        role="alert"
        data-testid="run-unavailable"
        className="h-fit w-full max-w-xl rounded-xl border border-gray-200 p-5 dark:border-gray-700"
      >
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t(`translation.formatted.storage.${text}Title`)}
        </h2>
        <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
          {t(`translation.formatted.storage.${text}Body`, {
            days: RUN_RETENTION_DAYS,
          })}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {problem !== 'missing' && (
            <button type="button" onClick={onRetry} className={PRIMARY}>
              {t('translation.formatted.storage.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={onStartOver}
            className={problem === 'missing' ? PRIMARY : SECONDARY}
          >
            {t('translation.formatted.storage.startOver')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FormattedRunStorageLineProps {
  runRef: NativeRunRef;
  /** The last save did not reach storage. */
  saveFailed: boolean;
}

/**
 * One quiet line saying where a translation's files are kept, until when,
 * and whether they are encrypted.
 */
export function FormattedRunStorageLine({
  runRef,
  saveFailed,
}: FormattedRunStorageLineProps) {
  const t = useTranslations('workflows');
  const locale = useLocale();
  const until =
    runRef.expiresAt &&
    new Date(runRef.expiresAt).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
    });
  return (
    <span
      data-testid="run-storage"
      className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400"
    >
      <IconCloud size={13} aria-hidden />
      {runRef.backend === 'onedrive'
        ? t('translation.formatted.storage.inOneDrive')
        : until
          ? t('translation.formatted.storage.inAppUntil', { date: until })
          : t('translation.formatted.storage.inApp')}
      {runRef.keyId && (
        <span className="inline-flex items-center gap-0.5">
          <IconLock size={12} aria-hidden />
          {t('translation.formatted.storage.encrypted')}
        </span>
      )}
      {saveFailed && (
        <span className="text-amber-700 dark:text-amber-400">
          {t('translation.formatted.storage.saveFailed')}
        </span>
      )}
    </span>
  );
}

interface FormattedRunExpiryWarningProps {
  /** The reference's `expiresAt`. */
  expiresAt: string | undefined;
  /** A keep request is in flight. */
  keeping: boolean;
  /** Keeps the files for another retention period. */
  onKeep: () => void;
}

/**
 * Warns that a translation's files are about to be deleted from app
 * storage, with the one action that prevents it. Renders nothing while
 * more than the warning period is left, or where nothing expires.
 */
export function FormattedRunExpiryWarning({
  expiresAt,
  keeping,
  onKeep,
}: FormattedRunExpiryWarningProps) {
  const t = useTranslations('workflows');
  if (!expiresAt || runExpiryState(expiresAt) !== 'soon') return null;
  return (
    <div
      role="status"
      data-testid="run-expiry-warning"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <span>
        {t('translation.formatted.storage.expiresSoon', {
          count: runDaysLeft(expiresAt),
        })}
      </span>
      <button
        type="button"
        disabled={keeping}
        onClick={onKeep}
        className="rounded-md border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
      >
        {t('translation.formatted.storage.keep', { days: RUN_RETENTION_DAYS })}
      </button>
    </div>
  );
}
