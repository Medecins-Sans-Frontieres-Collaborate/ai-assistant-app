'use client';

import { FC, useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { LocalStorageService } from '@/client/services/storage/localStorageService';

import { exportData } from '@/lib/utils/app/export/importExport';
import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

import {
  IncrementalMigrationResult,
  IncrementalProgress,
  MigrationResult,
  MigrationStats,
  QuotaAnalysis,
  SkippedItem,
} from '@/types/storage';

type MigrationStatus =
  | 'checking'
  | 'prompt'
  | 'quota_warning'
  | 'migrating'
  | 'complete'
  | 'partial'
  | 'error'
  | 'skipped';

interface MigrationDialogProps {
  isOpen: boolean;
  onComplete: () => void;
}

/**
 * Dialog shown to users when legacy localStorage data needs migration.
 * Provides options to migrate data or skip, with progress feedback.
 * Handles quota limits by offering incremental migration mode.
 */
export const MigrationDialog: FC<MigrationDialogProps> = ({
  isOpen,
  onComplete,
}) => {
  const t = useTranslations();
  const [status, setStatus] = useState<MigrationStatus>('checking');
  const [stats, setStats] = useState<MigrationStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Quota and incremental migration state
  const [quotaAnalysis, setQuotaAnalysis] = useState<QuotaAnalysis | null>(
    null,
  );
  const [useIncrementalMode, setUseIncrementalMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [progress, setProgress] = useState<IncrementalProgress | null>(null);
  const [skippedItems, setSkippedItems] = useState<SkippedItem[]>([]);

  // Legacy data cleanup option
  // Default unchecked for dev/debug - change to true for production if desired
  const DELETE_LEGACY_DEFAULT = false;
  const [deleteAfterMigration, setDeleteAfterMigration] = useState(
    DELETE_LEGACY_DEFAULT,
  );
  const [freedBytes, setFreedBytes] = useState(0);

  // Check quota when dialog opens
  useEffect(() => {
    if (isOpen && status === 'checking') {
      // Defer state updates to avoid synchronous cascading renders
      queueMicrotask(() => {
        const analysis = LocalStorageService.analyzeQuotaForMigration();
        setQuotaAnalysis(analysis);

        if (analysis.wouldExceedQuota) {
          setUseIncrementalMode(true); // Default ON when quota exceeded
          setStatus('quota_warning');
        } else {
          setStatus('prompt');
        }
      });
    }
  }, [isOpen, status]);

  const handleMigrate = useCallback(async () => {
    setStatus('migrating');

    // Small delay to show the progress animation
    await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      if (useIncrementalMode) {
        // Incremental migration with progress tracking
        const result: IncrementalMigrationResult =
          LocalStorageService.migrateIncrementally((prog) => {
            setProgress(prog);
          });

        if (result.hasSkippedItems) {
          setStats(result.stats);
          setWarnings(result.warnings || []);
          setSkippedItems(result.skippedItems);
          setStatus('partial');
        } else if (result.success) {
          setStats(result.stats);
          setWarnings(result.warnings || []);
          // Delete legacy data if option enabled
          if (deleteAfterMigration) {
            const deleteResult = LocalStorageService.deleteLegacyData();
            setFreedBytes(deleteResult.freedBytes);
          }
          setStatus('complete');
        } else {
          setError(result.errors.join('\n') || 'Unknown error occurred');
          setWarnings(result.warnings || []);
          setStatus('error');
        }
      } else {
        // Standard migration
        const result: MigrationResult = LocalStorageService.migrateFromLegacy();

        if (result.success) {
          setStats(result.stats);
          setWarnings(result.warnings || []);
          // Delete legacy data if option enabled
          if (deleteAfterMigration) {
            const deleteResult = LocalStorageService.deleteLegacyData();
            setFreedBytes(deleteResult.freedBytes);
          }
          setStatus('complete');
        } else {
          setError(result.errors.join('\n') || 'Unknown error occurred');
          setWarnings(result.warnings || []);
          setStatus('error');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }, [useIncrementalMode, deleteAfterMigration]);

  const handleSkip = useCallback(() => {
    // Mark as skipped in localStorage so we don't show again
    if (typeof window !== 'undefined') {
      localStorage.setItem('data_migration_v2_skipped', 'true');
    }
    setStatus('skipped');
    onComplete();
  }, [onComplete]);

  const handleContinue = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const handleRetry = useCallback(() => {
    setError(null);
    setSkippedItems([]);
    setProgress(null);
    // Re-check quota
    const analysis = LocalStorageService.analyzeQuotaForMigration();
    setQuotaAnalysis(analysis);
    if (analysis.wouldExceedQuota) {
      setUseIncrementalMode(true);
      setStatus('quota_warning');
    } else {
      setStatus('prompt');
    }
  }, []);

  const handleExportBackup = useCallback(async () => {
    try {
      await exportData();
    } catch (err) {
      console.error('Export failed:', err);
    }
  }, []);

  const handleExportSkipped = useCallback(() => {
    if (skippedItems.length === 0) return;

    const data = LocalStorageService.exportSkippedItems(skippedItems);
    const exportObj = {
      version: 5,
      type: 'skipped_migration_items',
      exportedAt: new Date().toISOString(),
      ...data,
    };

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `skipped_items_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [skippedItems]);

  const handleContinueWithoutSkipped = useCallback(() => {
    // Mark migration as complete even with skipped items
    if (typeof window !== 'undefined') {
      localStorage.setItem('data_migration_v2_complete', 'true');
    }
    onComplete();
  }, [onComplete]);

  if (!isOpen) return null;

  // Build stats summary for display
  const getStatsSummary = (): string[] => {
    if (!stats) return [];
    const items: string[] = [];
    if (stats.conversations > 0) {
      items.push(
        `${stats.conversations} ${stats.conversations === 1 ? t('conversation') : t('conversations')}`,
      );
    }
    if (stats.folders > 0) {
      items.push(
        `${stats.folders} ${stats.folders === 1 ? t('folder') : t('folders')}`,
      );
    }
    if (stats.prompts > 0) {
      items.push(
        `${stats.prompts} ${stats.prompts === 1 ? t('prompt') : t('prompts')}`,
      );
    }
    if (stats.customAgents > 0) {
      items.push(
        `${stats.customAgents} ${stats.customAgents === 1 ? t('custom agent') : t('custom agents')}`,
      );
    }
    return items;
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-[#1f1f1f] rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-gray-300 dark:border-gray-600">
        {/* Checking State - Analyzing quota */}
        {status === 'checking' && (
          <div className="px-6 py-8">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                <div className="w-6 h-6 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white mb-2">
                {t('Checking Storage')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('Analyzing your data...')}
              </p>
            </div>
          </div>
        )}

        {/* Prompt State - Ask user if they want to migrate */}
        {status === 'prompt' && (
          <>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30">
                  <svg
                    className="w-5 h-5 text-blue-600 dark:text-blue-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('Update Available')}
                </h2>
              </div>

              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                {t(
                  'We found data from a previous version. Would you like to migrate it to work with the improved system?',
                )}
              </p>

              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 mb-4">
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-2">
                  {t('Benefits')}:
                </p>
                <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
                  <li className="flex items-center gap-2">
                    <svg
                      className="w-3.5 h-3.5 text-green-500 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t('Faster performance')}
                  </li>
                  <li className="flex items-center gap-2">
                    <svg
                      className="w-3.5 h-3.5 text-green-500 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t('Better reliability')}
                  </li>
                  <li className="flex items-center gap-2">
                    <svg
                      className="w-3.5 h-3.5 text-green-500 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t('Your data is preserved')}
                  </li>
                </ul>
              </div>

              {/* Advanced Options (collapsed by default) */}
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                {t('Advanced options')}
              </button>

              {showAdvanced && (
                <div className="mt-2 pl-5 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useIncrementalMode}
                      onChange={(e) => setUseIncrementalMode(e.target.checked)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    {t('Use incremental mode')}
                    <span className="text-gray-400 dark:text-gray-500">
                      ({t('slower but safer')})
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteAfterMigration}
                      onChange={(e) =>
                        setDeleteAfterMigration(e.target.checked)
                      }
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    {t('Delete legacy data after migration')}
                    <span className="text-gray-400 dark:text-gray-500">
                      ({t('frees up storage space')})
                    </span>
                  </label>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleSkip}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('Skip')}
              </button>
              <button
                onClick={handleMigrate}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('Migrate Data')}
              </button>
            </div>
          </>
        )}

        {/* Quota Warning State - Storage space is limited */}
        {status === 'quota_warning' && quotaAnalysis && (
          <>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-yellow-100 dark:bg-yellow-900/30">
                  <svg
                    className="w-5 h-5 text-yellow-600 dark:text-yellow-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('Storage Space Limited')}
                </h2>
              </div>

              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                {t(
                  'Your data requires more space than is currently available. We recommend using incremental migration mode.',
                )}
              </p>

              <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 mb-4 border border-yellow-200 dark:border-yellow-800">
                <div className="text-xs text-yellow-700 dark:text-yellow-300 space-y-1">
                  <div className="flex justify-between">
                    <span>{t('Available space')}:</span>
                    <span className="font-medium">
                      {formatBytes(quotaAnalysis.availableSpace)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('Data to migrate')}:</span>
                    <span className="font-medium">
                      {formatBytes(quotaAnalysis.legacySize)}
                    </span>
                  </div>
                  <div className="flex justify-between text-yellow-800 dark:text-yellow-200">
                    <span>{t('Additional space needed')}:</span>
                    <span className="font-medium">
                      {formatBytes(quotaAnalysis.deficit)}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleExportBackup}
                className="w-full mb-3 py-2 px-4 rounded-lg text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex items-center justify-center gap-2"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                {t('Export Backup First')}
              </button>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useIncrementalMode}
                    onChange={(e) => setUseIncrementalMode(e.target.checked)}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  {t('Use incremental mode')}
                  <span className="text-green-600 dark:text-green-400 font-medium">
                    ({t('recommended')})
                  </span>
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteAfterMigration}
                    onChange={(e) => setDeleteAfterMigration(e.target.checked)}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  {t('Delete legacy data after migration')}
                  <span className="text-gray-400 dark:text-gray-500">
                    ({t('frees up storage space')})
                  </span>
                </label>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleSkip}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('Skip')}
              </button>
              <button
                onClick={handleMigrate}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('Migrate Anyway')}
              </button>
            </div>
          </>
        )}

        {/* Migrating State - Show progress */}
        {status === 'migrating' && (
          <div className="px-6 py-8">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                <div className="w-6 h-6 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white mb-2">
                {t('Migrating Data')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {progress
                  ? `${t(progress.phase === 'conversations' ? 'Migrating conversations' : progress.phase === 'prompts' ? 'Migrating prompts' : progress.phase === 'agents' ? 'Migrating agents' : 'Finishing up')}... ${progress.current}/${progress.total}`
                  : t('Please wait while we update your data...')}
              </p>

              {/* Progress bar */}
              <div className="mt-6 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                {progress ? (
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-300"
                    style={{
                      width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                    }}
                  ></div>
                ) : (
                  <div className="h-full bg-blue-600 rounded-full animate-pulse w-3/4"></div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Complete State - Show results */}
        {status === 'complete' && (
          <>
            <div className="px-6 py-5">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-green-100 dark:bg-green-900/30">
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
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('Migration Complete')}
                </h2>
              </div>

              {getStatsSummary().length > 0 ? (
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                    {t('Successfully migrated')}:
                  </p>
                  <ul className="text-sm text-gray-700 dark:text-gray-200 space-y-1">
                    {getStatsSummary().map((item, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <svg
                          className="w-4 h-4 text-green-500 flex-shrink-0"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-300 text-center">
                  {t('Your settings have been updated.')}
                </p>
              )}

              {/* Warnings section */}
              {warnings.length > 0 && (
                <div className="mt-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 border border-yellow-200 dark:border-yellow-800">
                  <p className="text-xs text-yellow-700 dark:text-yellow-400 font-medium mb-1">
                    {t('Notes')}:
                  </p>
                  <ul className="text-xs text-yellow-600 dark:text-yellow-300 space-y-1">
                    {warnings.slice(0, 3).map((warning, index) => (
                      <li key={index} className="flex items-start gap-1.5">
                        <span className="mt-0.5">-</span>
                        <span>{warning}</span>
                      </li>
                    ))}
                    {warnings.length > 3 && (
                      <li className="text-yellow-500 dark:text-yellow-400">
                        ...and {warnings.length - 3} more (see console)
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Legacy data deleted message */}
              {freedBytes > 0 && (
                <div className="mt-3 text-xs text-green-600 dark:text-green-400 text-center">
                  {t('Legacy data deleted')} - {formatBytes(freedBytes)}{' '}
                  {t('freed')}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={handleContinue}
                className="w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('Continue')}
              </button>
            </div>
          </>
        )}

        {/* Partial State - Some items skipped */}
        {status === 'partial' && (
          <>
            <div className="px-6 py-5">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-yellow-100 dark:bg-yellow-900/30">
                  <svg
                    className="w-6 h-6 text-yellow-600 dark:text-yellow-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('Partially Complete')}
                </h2>
              </div>

              {getStatsSummary().length > 0 && (
                <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 mb-3 border border-green-200 dark:border-green-800">
                  <p className="text-xs text-green-700 dark:text-green-400 font-medium mb-1">
                    {t('Successfully migrated')}:
                  </p>
                  <ul className="text-xs text-green-600 dark:text-green-300">
                    {getStatsSummary().map((item, index) => (
                      <li key={index}>- {item}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 mb-4 border border-yellow-200 dark:border-yellow-800">
                <p className="text-xs text-yellow-700 dark:text-yellow-400 font-medium mb-1">
                  {t('Could not migrate')} ({skippedItems.length}{' '}
                  {skippedItems.length === 1 ? t('item') : t('items')}):
                </p>
                <ul className="text-xs text-yellow-600 dark:text-yellow-300 space-y-1">
                  {skippedItems.slice(0, 3).map((item, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <span className="mt-0.5">-</span>
                      <span>
                        {item.name} ({formatBytes(item.size)})
                      </span>
                    </li>
                  ))}
                  {skippedItems.length > 3 && (
                    <li className="text-yellow-500 dark:text-yellow-400">
                      ...and {skippedItems.length - 3} more
                    </li>
                  )}
                </ul>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                {t(
                  'These items are too large to fit in storage. You can export them, free up space, or continue without them.',
                )}
              </p>

              <div className="space-y-2">
                <button
                  onClick={handleExportSkipped}
                  className="w-full py-2 px-4 rounded-lg text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex items-center justify-center gap-2"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  {t('Export Skipped Items')}
                </button>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleRetry}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('Retry')}
              </button>
              <button
                onClick={handleContinueWithoutSkipped}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('Continue')}
              </button>
            </div>
          </>
        )}

        {/* Error State */}
        {status === 'error' && (
          <>
            <div className="px-6 py-5">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-red-100 dark:bg-red-900/30">
                  <svg
                    className="w-6 h-6 text-red-600 dark:text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {t('Migration Failed')}
                </h2>
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {error}
                </p>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                {t(
                  'Your original data is safe. You can try again or skip for now.',
                )}
              </p>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-3">
              <button
                onClick={handleSkip}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
              >
                {t('Skip')}
              </button>
              <button
                onClick={handleRetry}
                className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
              >
                {t('Retry')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MigrationDialog;
