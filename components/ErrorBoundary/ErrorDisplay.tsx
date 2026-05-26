'use client';

import {
  IconAlertTriangle,
  IconCopy,
  IconDownload,
  IconRefresh,
} from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  clearAllConversationStorage,
  exportRawConversationData,
} from '@/lib/utils/app/storage/perConversationStorage';

import { FEEDBACK_EMAIL } from '@/types/contact';

interface ErrorDisplayProps {
  error: Error & { digest?: string };
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  showSupportInfo?: boolean;
  /** Show "Export data" link for saving raw conversation data before recovery */
  showDataExport?: boolean;
  /** Show "Reset storage" escape hatch for unrecoverable storage corruption */
  showStorageReset?: boolean;
}

export function ErrorDisplay({
  error,
  title,
  description,
  onRetry,
  retryLabel,
  showSupportInfo = true,
  showDataExport = false,
  showStorageReset = false,
}: ErrorDisplayProps) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Use default feedback email - error contexts may not have session providers
  const supportEmail = FEEDBACK_EMAIL;

  const copyErrorToClipboard = async () => {
    const errorText = `Error: ${error.message || 'An error occurred'}${error.digest ? `\nError ID: ${error.digest}` : ''}`;
    await navigator.clipboard.writeText(errorText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportData = () => {
    try {
      const data = exportRawConversationData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conversation-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExported(true);
    } catch (e) {
      console.error('Failed to export data:', e);
    }
  };

  const handleResetStorage = () => {
    clearAllConversationStorage();
    window.location.reload();
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-white dark:bg-[#212121] p-4">
      <div className="relative rounded-xl bg-white dark:bg-[#171717] p-6 shadow-xl border border-red-200 dark:border-red-900/50 w-full max-w-xl animate-in fade-in slide-in-from-bottom-4 duration-300">
        {/* Header with Icon and Title */}
        <div className="flex items-center gap-4 mb-6">
          <div className="rounded-full bg-red-100 dark:bg-red-900/30 p-3 flex-shrink-0">
            <IconAlertTriangle
              size={24}
              className="text-red-600 dark:text-red-400"
              strokeWidth={2}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              {title || t('errors.somethingWentWrong')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {description || t('errors.anErrorOccurred')}
            </p>
          </div>
        </div>

        {/* Error Message with Copy Button */}
        <div className="rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 px-4 py-4 mb-6">
          <div className="flex items-start justify-between gap-3 mb-3">
            <p className="text-sm text-red-800 dark:text-red-300 break-words font-mono flex-1 leading-relaxed">
              {error.message || 'An error occurred'}
            </p>
            <button
              onClick={copyErrorToClipboard}
              className="flex-shrink-0 p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
              title={t('errors.copyErrorMessage')}
            >
              {copied ? (
                <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                  ✓
                </span>
              ) : (
                <IconCopy
                  size={16}
                  className="text-red-600 dark:text-red-400"
                />
              )}
            </button>
          </div>
          {error.digest && (
            <p className="text-xs text-red-700 dark:text-red-400 font-mono">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        {/* Retry Button */}
        {onRetry && (
          <button
            onClick={onRetry}
            className="w-full rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 px-4 py-2 text-white text-sm font-medium shadow-md hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2 group mb-5"
          >
            <IconRefresh
              size={16}
              className="group-hover:rotate-180 transition-transform duration-500"
            />
            {retryLabel || t('common.tryAgain')}
          </button>
        )}

        {/* Support Instructions */}
        {showSupportInfo && (
          <div className="text-center">
            <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
              {t('errors.contactSupport')}{' '}
              <a
                href={`mailto:${supportEmail}`}
                className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
              >
                {supportEmail}
              </a>
            </p>
          </div>
        )}

        {/* Data Export */}
        {showDataExport && (
          <div className="mt-3 text-center">
            <button
              onClick={handleExportData}
              className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              <IconDownload size={13} />
              {exported
                ? t('errors.dataExported')
                : t('errors.exportDataForRecovery')}
            </button>
            {exported && (
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                {t('errors.exportDataDescription')}
              </p>
            )}
          </div>
        )}

        {/* Storage Reset */}
        {showStorageReset && (
          <div className="mt-3 text-center">
            {!showResetConfirm ? (
              <button
                onClick={() => setShowResetConfirm(true)}
                className="text-xs text-gray-500 dark:text-gray-400 hover:underline"
              >
                {t('errors.resetStoragePrompt')}
              </button>
            ) : (
              <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 px-4 py-3 space-y-3">
                <p className="text-xs text-red-700 dark:text-red-300">
                  {t('errors.resetStorageWarning')}
                </p>
                <div className="flex gap-2 justify-center flex-wrap">
                  <button
                    onClick={handleExportData}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  >
                    <IconDownload size={13} />
                    {exported
                      ? t('errors.dataExported')
                      : t('errors.exportDataForRecovery')}
                  </button>
                  <button
                    onClick={handleResetStorage}
                    className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    {t('errors.resetStorage')}
                  </button>
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
