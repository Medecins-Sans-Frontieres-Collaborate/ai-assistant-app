'use client';

import {
  IconBrandOnedrive,
  IconCloudUpload,
  IconEye,
  IconKey,
  IconServer,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useFormatter, useTranslations } from 'next-intl';

import { useBackupSync } from '@/client/hooks/backup/useBackupSync';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  clearMasterKey,
  getBackupKeys,
} from '@/client/services/backup/keystore';
import type { BackupBackend, SyncStatus } from '@/lib/services/backup/types';

import {
  disableBackupAt,
  switchBackupBackend,
} from '@/lib/utils/app/backup/backupOps';
import { getConversationDataSize } from '@/lib/utils/app/storage/perConversationStorage';

import { ConfirmDialog } from '@/components/UI/ConfirmDialog';

import { useBackupStore } from '@/client/stores/backupStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
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
  const storageBackend = useBackupStore((s) => s.storageBackend);
  const setBackupModalView = useUIStore((s) => s.setBackupModalView);

  const { backupEnabled: oneDriveBackupEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);

  const { status, lastBackupAt, syncNow } = useBackupSync();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<BackupBackend | null>(
    null,
  );
  const [isSwitching, setIsSwitching] = useState(false);

  const enrolled = enrollmentStatus === 'enrolled';
  const keyTail = localKeyId ? localKeyId.slice(-4).toUpperCase() : null;
  // OneDrive as a DESTINATION needs flag + connection; an enrollment already
  // pointing at OneDrive keeps its controls even if the flag later flips
  // (the user must always be able to move back or turn off).
  const showStorageChoice =
    (oneDriveBackupEnabled && m365Connected) || storageBackend === 'onedrive';

  const backendLabel = (backend: BackupBackend): string =>
    backend === 'onedrive'
      ? t('backup.settings.storageOneDrive')
      : t('backup.settings.storageApp');

  const localSizeLabel = (): string => {
    const bytes = getConversationDataSize();
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const handleChooseBackend = (target: BackupBackend) => {
    if (target === storageBackend || isSwitching) return;
    if (!enrolled) {
      // Nothing to migrate — just point future enrolls/restores at the
      // chosen location and refresh what exists there.
      useBackupStore.getState().setStorageBackend(target);
      void useBackupStore.getState().refreshRemoteStatus();
      return;
    }
    setPendingSwitch(target);
  };

  const handleConfirmSwitch = async () => {
    const target = pendingSwitch;
    setPendingSwitch(null);
    if (target === null) return;
    setIsSwitching(true);
    try {
      const keys = await getBackupKeys();
      if (!keys) {
        toast.error(t('backup.settings.storageSwitchFailure'));
        return;
      }
      const result = await switchBackupBackend(target, keys);
      if (result.cleanupFailed) {
        toast(t('backup.settings.storageSwitchCleanupWarning'), {
          icon: '⚠️',
        });
      } else {
        toast.success(
          t('backup.settings.storageSwitchSuccess', {
            count: result.pushed,
          }),
        );
      }
    } catch {
      toast.error(t('backup.settings.storageSwitchFailure'));
    } finally {
      setIsSwitching(false);
    }
  };

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
      // Pull-merge first so conversations another device pushed land locally
      // before the remote copy is destroyed. Best-effort: local data is the
      // working copy either way, and turn-off must not be blocked by a
      // broken remote.
      await syncNow();
      const { remoteKeyEpoch, localKeyEpoch, storageBackend, clearEnrollment } =
        useBackupStore.getState();
      // Disable is a key-state change: other devices must find a tombstone
      // with a bumped epoch, not a bare 404 (which reads as "never existed").
      await disableBackupAt(
        storageBackend,
        Math.max(remoteKeyEpoch ?? 0, localKeyEpoch),
      );
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

        {/* Storage location — app storage vs the user's OneDrive app folder.
            The working copy always stays in this browser's storage; this
            only decides where the encrypted mirror lives. */}
        {showStorageChoice && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              {t('backup.settings.storageLocationTitle')}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {t('backup.settings.storageLocationDescription', {
                size: localSizeLabel(),
              })}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(['app', 'onedrive'] as const).map((backend) => {
                const active = storageBackend === backend;
                return (
                  <button
                    key={backend}
                    type="button"
                    onClick={() => handleChooseBackend(backend)}
                    disabled={isSwitching}
                    aria-pressed={active}
                    className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/30'
                        : 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'
                    } disabled:cursor-default`}
                  >
                    {backend === 'onedrive' ? (
                      <IconBrandOnedrive
                        size={20}
                        className="mt-0.5 shrink-0 text-gray-600 dark:text-gray-300"
                      />
                    ) : (
                      <IconServer
                        size={20}
                        className="mt-0.5 shrink-0 text-gray-600 dark:text-gray-300"
                      />
                    )}
                    <span>
                      <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                        {backendLabel(backend)}
                        {active && (
                          <span className="ml-1.5 text-xs font-normal text-blue-600 dark:text-blue-400">
                            {t('backup.settings.storageActive')}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                        {backend === 'onedrive'
                          ? t('backup.settings.storageOneDriveDescription')
                          : t('backup.settings.storageAppDescription')}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {isSwitching && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('backup.settings.storageSwitching')}
              </p>
            )}
          </div>
        )}

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
        message={`${t('backup.settings.turnOffConfirmMessage')} ${t(
          'backup.settings.turnOffLocalNote',
          { size: localSizeLabel() },
        )}`}
        confirmLabel={t('backup.settings.turnOffConfirmAction')}
        confirmVariant="danger"
        onConfirm={handleDisableAndDelete}
        onCancel={() => setShowDisableConfirm(false)}
      />

      <ConfirmDialog
        isOpen={pendingSwitch !== null}
        title={t('backup.settings.storageSwitchConfirmTitle', {
          target: pendingSwitch ? backendLabel(pendingSwitch) : '',
        })}
        message={t('backup.settings.storageSwitchConfirmMessage', {
          target: pendingSwitch ? backendLabel(pendingSwitch) : '',
        })}
        confirmLabel={t('backup.settings.storageSwitchAction')}
        onConfirm={handleConfirmSwitch}
        onCancel={() => setPendingSwitch(null)}
      />
    </div>
  );
};
