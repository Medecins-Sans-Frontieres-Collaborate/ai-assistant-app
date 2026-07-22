'use client';

import {
  IconCloudUpload,
  IconEye,
  IconKey,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useFormatter, useTranslations } from 'next-intl';

import { useBackupSync } from '@/client/hooks/backup/useBackupSync';

import { clearMasterKey } from '@/client/services/backup/keystore';
import { createBackupApiClient } from '@/lib/services/backup/backupApiClient';
import type { BackupManifest, SyncStatus } from '@/lib/services/backup/types';

import { ConfirmDialog } from '@/components/UI/ConfirmDialog';

import { useBackupStore } from '@/client/stores/backupStore';
import { useUIStore } from '@/client/stores/uiStore';

/** SyncStatus values → camelCase i18n key suffixes under backup.settings.syncState. */
const SYNC_STATE_KEYS: Record<SyncStatus, string> = {
  idle: 'idle',
  syncing: 'syncing',
  ok: 'ok',
  'key-out-of-date': 'keyOutOfDate',
  'remote-missing': 'remoteMissing',
  error: 'error',
};

const actionButtonClasses =
  'inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BackupSection: FC = () => {
  const t = useTranslations();
  const format = useFormatter();

  const enrollmentStatus = useBackupStore((s) => s.enrollmentStatus);
  const localKeyId = useBackupStore((s) => s.localKeyId);
  const remoteExists = useBackupStore((s) => s.remoteExists);
  const lastSyncError = useBackupStore((s) => s.lastSyncError);
  const setBackupModalView = useUIStore((s) => s.setBackupModalView);

  const { status, lastBackupAt, syncNow } = useBackupSync();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);

  const enrolled = enrollmentStatus === 'enrolled';
  const keyTail = localKeyId ? localKeyId.slice(-4).toUpperCase() : null;

  const handleBackUpNow = async () => {
    setIsBackingUp(true);
    try {
      const result = await syncNow();
      if (result?.status === 'ok') {
        toast.success(t('backup.settings.backUpNowSuccess'));
      } else {
        toast.error(t('backup.settings.backUpNowFailure'));
      }
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleDisableAndDelete = async () => {
    setShowDisableConfirm(false);
    setIsDisabling(true);
    try {
      const api = createBackupApiClient();
      await api.deleteBackup();
      const { remoteKeyEpoch, localKeyEpoch, clearEnrollment } =
        useBackupStore.getState();
      // Disable is a key-state change: other devices must find a tombstone
      // with a bumped epoch, not a bare 404 (which reads as "never existed").
      const tombstone: BackupManifest = {
        schemaVersion: 1,
        keyId: null,
        epoch: Math.max(remoteKeyEpoch ?? 0, localKeyEpoch) + 1,
        // The prefix wipe above removed the old manifest, so this write is a
        // fresh create — the server requires version 1 with no If-Match.
        version: 1,
        updatedAt: new Date().toISOString(),
        disabled: true,
        folders: null,
        conversations: {},
      };
      await api.putManifest(tombstone, { ifMatchEtag: null });
      await clearMasterKey();
      clearEnrollment();
      // Refresh the cached remote snapshot so the off-state doesn't offer a
      // restore of the backup we just deleted.
      void useBackupStore.getState().refreshRemoteStatus();
      toast.success(t('backup.settings.turnOffSuccess'));
    } catch {
      toast.error(t('backup.settings.turnOffFailure'));
    } finally {
      setIsDisabling(false);
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-6">
        <IconShieldLock size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Backup')}
        </h2>
      </div>

      <div className="space-y-6">
        {/* Status card */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-surface-dark p-4">
          <p className="text-lg font-semibold text-black dark:text-white">
            {enrolled
              ? t('backup.settings.statusOn')
              : t('backup.settings.statusOff')}
          </p>
          {enrolled ? (
            <>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {lastBackupAt
                  ? t('backup.settings.lastBackup', {
                      time: format.relativeTime(new Date(lastBackupAt)),
                    })
                  : t('backup.settings.lastBackupNever')}
              </p>
              {keyTail && (
                <p className="mt-1 font-mono text-sm text-gray-600 dark:text-gray-400">
                  {t('backup.settings.keyFingerprint', { tail: keyTail })}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t(`backup.settings.syncState.${SYNC_STATE_KEYS[status]}`)}
              </p>
              {status === 'error' && lastSyncError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {lastSyncError}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t('backup.settings.offDescription')}
            </p>
          )}
        </div>

        {!enrolled && (
          <div className="space-y-4">
            {/* A live remote backup means the right entry point is restoring
                it with its key — a fresh enroll here could never push over a
                foreign-key manifest and would dead-end. */}
            {remoteExists !== true && (
              <button
                type="button"
                onClick={() => setBackupModalView('enroll-intro')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                <IconShieldLock size={16} />
                {t('backup.settings.turnOn')}
              </button>
            )}

            {remoteExists === true && (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {t('backup.settings.restoreTitle')}
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {t('backup.settings.restoreDescription')}
                </p>
                <button
                  type="button"
                  onClick={() => setBackupModalView('restore')}
                  className={`${actionButtonClasses} mt-2`}
                >
                  {t('backup.settings.restore')}
                </button>
              </div>
            )}
          </div>
        )}

        {enrolled && (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleBackUpNow}
                disabled={isBackingUp || status === 'syncing'}
                className={actionButtonClasses}
              >
                <IconCloudUpload size={16} />
                {t('backup.settings.backUpNow')}
              </button>
              <button
                type="button"
                onClick={() => setBackupModalView('view-key')}
                className={actionButtonClasses}
              >
                <IconEye size={16} />
                {t('backup.settings.viewKey')}
              </button>
              <button
                type="button"
                onClick={() => setBackupModalView('rotate-confirm')}
                className={actionButtonClasses}
              >
                <IconKey size={16} />
                {t('backup.settings.changeKey')}
              </button>
            </div>

            {/* Danger zone */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">
                {t('backup.settings.dangerTitle')}
              </h3>
              <button
                type="button"
                onClick={() => setShowDisableConfirm(true)}
                disabled={isDisabling}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <IconTrash size={16} />
                {t('backup.settings.turnOffDelete')}
              </button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        isOpen={showDisableConfirm}
        title={t('backup.settings.turnOffConfirmTitle')}
        message={t('backup.settings.turnOffConfirmMessage')}
        confirmLabel={t('backup.settings.turnOffConfirmAction')}
        confirmVariant="danger"
        onConfirm={handleDisableAndDelete}
        onCancel={() => setShowDisableConfirm(false)}
      />
    </div>
  );
};
