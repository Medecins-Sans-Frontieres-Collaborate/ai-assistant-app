'use client';

import {
  IconAlertCircle,
  IconAlertTriangle,
  IconDownload,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useStorageWarning } from '@/client/hooks/storage/useStorageWarning';

import { exportData } from '@/lib/utils/app/export/importExport';
import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

type DialogState = 'warning' | 'confirm_clear' | 'clearing' | 'complete';
type ClearMode = 'keepRecent' | 'olderThan';

interface StorageWarningDialogProps {
  isOpen: boolean;
  onClose: () => void;
  severity: 'WARNING' | 'CRITICAL' | 'EMERGENCY' | null;
  onClearComplete?: () => void;
}

/**
 * Number of days options for "clear older than" mode
 */
const DAYS_OPTIONS = [7, 14, 30, 60, 90] as const;

/**
 * Keep count options for "keep recent" mode
 */
const KEEP_COUNT_OPTIONS = [5, 10, 20, 30, 50] as const;

/**
 * Storage warning dialog that appears when storage usage exceeds thresholds.
 *
 * Features:
 * - Three severity levels (WARNING, CRITICAL, EMERGENCY) with appropriate styling
 * - Two clearing modes: keep recent X conversations or clear older than X days
 * - Real-time space estimates for each clearing option
 * - Export functionality before clearing
 * - Always dismissable (even at EMERGENCY level)
 * - Confirmation step before clearing
 */
export const StorageWarningDialog: FC<StorageWarningDialogProps> = ({
  isOpen,
  onClose,
  severity,
  onClearComplete,
}) => {
  const t = useTranslations('storageWarning');
  const {
    storageUsage,
    calculateSpaceByCount,
    calculateSpaceByDays,
    clearByCount,
    clearByDays,
    dismissWarning,
    refresh,
  } = useStorageWarning();

  // Dialog state
  const [state, setState] = useState<DialogState>('warning');
  const [clearMode, setClearMode] = useState<ClearMode>('keepRecent');
  const [keepCount, setKeepCount] = useState(10);
  const [olderThanDays, setOlderThanDays] = useState(30);

  // Estimate state
  const [estimate, setEstimate] = useState({
    spaceFreed: 0,
    conversationsRemoved: 0,
    percentFreed: 0,
  });

  // Result state
  const [clearResult, setClearResult] = useState<{
    success: boolean;
    conversationsRemoved: number;
    spaceFreed: number;
  } | null>(null);

  // Update estimate when options change
  useEffect(() => {
    if (!isOpen) return;

    // Defer state updates to avoid synchronous cascading renders
    queueMicrotask(() => {
      const newEstimate =
        clearMode === 'keepRecent'
          ? calculateSpaceByCount(keepCount)
          : calculateSpaceByDays(olderThanDays);

      setEstimate(newEstimate);
    });
  }, [
    isOpen,
    clearMode,
    keepCount,
    olderThanDays,
    calculateSpaceByCount,
    calculateSpaceByDays,
  ]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Defer state updates to avoid synchronous cascading renders
      queueMicrotask(() => {
        setState('warning');
        setClearResult(null);
        refresh();
      });
    }
  }, [isOpen, refresh]);

  /**
   * Handle dismiss action
   */
  const handleDismiss = useCallback(() => {
    dismissWarning();
    onClose();
  }, [dismissWarning, onClose]);

  /**
   * Handle export action
   */
  const handleExport = useCallback(async () => {
    try {
      await exportData();
    } catch (error) {
      console.error('Export failed:', error);
    }
  }, []);

  /**
   * Handle proceed to confirmation
   */
  const handleProceedToConfirm = useCallback(() => {
    setState('confirm_clear');
  }, []);

  /**
   * Handle cancel from confirmation
   */
  const handleCancelConfirm = useCallback(() => {
    setState('warning');
  }, []);

  /**
   * Handle actual clear action
   */
  const handleClear = useCallback(async () => {
    setState('clearing');

    // Small delay to show the progress animation
    await new Promise((resolve) => setTimeout(resolve, 300));

    const success =
      clearMode === 'keepRecent'
        ? clearByCount(keepCount)
        : clearByDays(olderThanDays);

    setClearResult({
      success,
      conversationsRemoved: estimate.conversationsRemoved,
      spaceFreed: estimate.spaceFreed,
    });

    setState('complete');
  }, [
    clearMode,
    keepCount,
    olderThanDays,
    clearByCount,
    clearByDays,
    estimate,
  ]);

  /**
   * Handle close after completion
   */
  const handleComplete = useCallback(() => {
    onClose();
    onClearComplete?.();
  }, [onClose, onClearComplete]);

  if (!isOpen || !severity) return null;

  // Severity-based styling
  const severityConfig = {
    WARNING: {
      bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
      iconColor: 'text-yellow-600 dark:text-yellow-400',
      borderColor: 'border-yellow-300 dark:border-yellow-700',
      textColor: 'text-yellow-800 dark:text-yellow-300',
      Icon: IconAlertTriangle,
    },
    CRITICAL: {
      bgColor: 'bg-orange-100 dark:bg-orange-900/30',
      iconColor: 'text-orange-600 dark:text-orange-400',
      borderColor: 'border-orange-300 dark:border-orange-700',
      textColor: 'text-orange-800 dark:text-orange-300',
      Icon: IconAlertTriangle,
    },
    EMERGENCY: {
      bgColor: 'bg-red-100 dark:bg-red-900/30',
      iconColor: 'text-red-600 dark:text-red-400',
      borderColor: 'border-red-300 dark:border-red-700',
      textColor: 'text-red-800 dark:text-red-300',
      Icon: IconAlertCircle,
    },
  };

  const config = severityConfig[severity];
  const SeverityIcon = config.Icon;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 p-4">
      <div className="bg-white dark:bg-surface-dark rounded-2xl shadow-xl max-w-md w-full overflow-hidden border border-gray-300 dark:border-gray-600">
        {/* Warning State */}
        {state === 'warning' && (
          <>
            <div className="px-6 py-5">
              {/* Header */}
              <div className="flex items-center gap-3 mb-4">
                <div
                  className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${config.bgColor}`}
                >
                  <SeverityIcon className={`w-5 h-5 ${config.iconColor}`} />
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t(`title.${severity.toLowerCase()}`)}
                </h2>
              </div>

              {/* Message */}
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                {t(`message.${severity.toLowerCase()}`, {
                  percent: storageUsage.percentUsed.toFixed(1),
                })}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                {t('consequence')}
              </p>

              {/* Storage bar */}
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>{t('storageUsage')}</span>
                  <span>
                    {formatBytes(storageUsage.currentUsage)} /{' '}
                    {formatBytes(storageUsage.maxUsage)}
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      severity === 'EMERGENCY'
                        ? 'bg-red-500'
                        : severity === 'CRITICAL'
                          ? 'bg-orange-500'
                          : 'bg-yellow-500'
                    }`}
                    style={{
                      width: `${Math.min(storageUsage.percentUsed, 100)}%`,
                    }}
                  />
                </div>
              </div>

              {/* Options section */}
              <div
                className={`rounded-lg p-3 mb-4 border ${config.borderColor} ${config.bgColor}`}
              >
                <p className={`text-xs font-medium mb-3 ${config.textColor}`}>
                  {t('optionsToFreeSpace')}
                </p>

                {/* Clear mode selection */}
                <div className="space-y-3">
                  {/* Option 1: Keep recent X */}
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="clearMode"
                      checked={clearMode === 'keepRecent'}
                      onChange={() => setClearMode('keepRecent')}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <span className="text-sm text-gray-700 dark:text-gray-200">
                        {t('clearOption.keepRecent')}
                      </span>
                      {clearMode === 'keepRecent' && (
                        <select
                          value={keepCount}
                          onChange={(e) => setKeepCount(Number(e.target.value))}
                          className="ml-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1"
                        >
                          {KEEP_COUNT_OPTIONS.map((count) => (
                            <option key={count} value={count}>
                              {count}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </label>

                  {/* Option 2: Clear older than X days */}
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="clearMode"
                      checked={clearMode === 'olderThan'}
                      onChange={() => setClearMode('olderThan')}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <span className="text-sm text-gray-700 dark:text-gray-200">
                        {t('clearOption.olderThan')}
                      </span>
                      {clearMode === 'olderThan' && (
                        <select
                          value={olderThanDays}
                          onChange={(e) =>
                            setOlderThanDays(Number(e.target.value))
                          }
                          className="ml-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1"
                        >
                          {DAYS_OPTIONS.map((days) => (
                            <option key={days} value={days}>
                              {t(`clearOption.days.${days}`)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </label>
                </div>

                {/* Estimate display */}
                {estimate.conversationsRemoved > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-600">
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      {t('estimate.willRemove', {
                        count: estimate.conversationsRemoved,
                      })}
                    </p>
                    <p className="text-xs font-medium text-green-600 dark:text-green-400">
                      {t('estimate.willFree', {
                        size: formatBytes(estimate.spaceFreed),
                      })}
                    </p>
                  </div>
                )}
              </div>

              {/* Export button */}
              <button
                onClick={handleExport}
                className="w-full mb-3 py-2 px-4 rounded-lg text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex items-center justify-center gap-2"
              >
                <IconDownload size={16} />
                {t('action.exportFirst')}
              </button>
            </div>

            {/* Action buttons */}
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleDismiss}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('action.dismiss')}
              </button>
              <button
                onClick={handleProceedToConfirm}
                disabled={estimate.conversationsRemoved === 0}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <IconTrash size={16} />
                {t('action.clearNow')}
              </button>
            </div>
          </>
        )}

        {/* Confirm Clear State */}
        {state === 'confirm_clear' && (
          <>
            <div className="px-6 py-5">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-red-100 dark:bg-red-900/30">
                  <IconAlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('confirm.title')}
                </h2>
              </div>

              <p className="text-sm text-gray-600 dark:text-gray-300 text-center mb-4">
                {t('confirm.message', { count: estimate.conversationsRemoved })}
              </p>

              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('estimate.willFree', {
                    size: formatBytes(estimate.spaceFreed),
                  })}
                </p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleCancelConfirm}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('action.cancel')}
              </button>
              <button
                onClick={handleClear}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-red-600 hover:bg-red-700 text-white shadow-md hover:shadow-lg"
              >
                {t('action.clearNow')}
              </button>
            </div>
          </>
        )}

        {/* Clearing State */}
        {state === 'clearing' && (
          <div className="px-6 py-8">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                <div className="w-6 h-6 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white mb-2">
                {t('clearing.title')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('clearing.message')}
              </p>
            </div>
          </div>
        )}

        {/* Complete State */}
        {state === 'complete' && clearResult && (
          <>
            <div className="px-6 py-5">
              <div className="text-center mb-4">
                <div
                  className={`inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full ${
                    clearResult.success
                      ? 'bg-green-100 dark:bg-green-900/30'
                      : 'bg-red-100 dark:bg-red-900/30'
                  }`}
                >
                  {clearResult.success ? (
                    <svg
                      className="w-6 h-6 text-green-600 dark:text-green-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <IconAlertCircle className="w-6 h-6 text-red-600 dark:text-red-400" />
                  )}
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {clearResult.success ? t('success.title') : t('error.title')}
                </h2>
              </div>

              {clearResult.success ? (
                <p className="text-sm text-gray-600 dark:text-gray-300 text-center">
                  {t('success.message', {
                    count: clearResult.conversationsRemoved,
                    size: formatBytes(clearResult.spaceFreed),
                  })}
                </p>
              ) : (
                <p className="text-sm text-red-600 dark:text-red-400 text-center">
                  {t('error.message')}
                </p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={handleComplete}
                className="w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default StorageWarningDialog;
