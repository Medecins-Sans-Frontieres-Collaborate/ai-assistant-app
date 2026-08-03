'use client';

import {
  IconBrandOnedrive,
  IconCloudUpload,
  IconDeviceLaptop,
  IconEye,
  IconKey,
  IconLoader2,
  IconServer,
  IconShieldLock,
} from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useFormatter, useTranslations } from 'next-intl';

import { useBackupSync } from '@/client/hooks/backup/useBackupSync';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { clearMasterKey } from '@/client/services/backup/keystore';
import {
  PLAIN_BACKUP_KEY_ID,
  isPlainBackupKeyId,
} from '@/lib/services/backup/plainCrypto';
import { runSync } from '@/lib/services/backup/syncEngine';
import type { BackupBackend, SyncStatus } from '@/lib/services/backup/types';

import {
  buildBackupSyncDeps,
  disableBackupAt,
  pushFullBackup,
  resolveCryptoSource,
  switchBackupBackend,
} from '@/lib/utils/app/backup/backupOps';
import { getConversationDataSize } from '@/lib/utils/app/storage/perConversationStorage';

import { ConfirmDialog } from '@/components/UI/ConfirmDialog';

import type { BackupEncryptionMode } from '@/client/stores/backupStore';
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

/** Where chats live: only in this browser, or mirrored to a cloud backend. */
type StorageChoice = 'local' | BackupBackend;

const actionButtonClasses =
  'inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BackupSection: FC = () => {
  const t = useTranslations();
  const format = useFormatter();

  const enrollmentStatus = useBackupStore((s) => s.enrollmentStatus);
  const localKeyId = useBackupStore((s) => s.localKeyId);
  const remoteExists = useBackupStore((s) => s.remoteExists);
  const remoteKeyId = useBackupStore((s) => s.remoteKeyId);
  const lastSyncError = useBackupStore((s) => s.lastSyncError);
  const storageBackend = useBackupStore((s) => s.storageBackend);
  const storageChosen = useBackupStore((s) => s.storageChosen);
  const encryptionMode = useBackupStore((s) => s.encryptionMode);
  const setBackupModalView = useUIStore((s) => s.setBackupModalView);

  const { backupEnabled: oneDriveBackupEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);

  const { status, lastBackupAt, syncNow } = useBackupSync();

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<StorageChoice | null>(
    null,
  );
  const [pendingMode, setPendingMode] = useState<BackupEncryptionMode | null>(
    null,
  );
  const [showPlainEnable, setShowPlainEnable] = useState(false);
  // The storage option currently being migrated to (drives the per-option
  // spinner). One migration at a time; mode changes share the same slot.
  const [busyTarget, setBusyTarget] = useState<StorageChoice | 'mode' | null>(
    null,
  );

  const enrolled = enrollmentStatus === 'enrolled';
  const plainMode = encryptionMode === 'plain';
  const keyTail =
    localKeyId && !isPlainBackupKeyId(localKeyId)
      ? localKeyId.slice(-4).toUpperCase()
      : null;
  // Not enrolled = chats live only in this browser.
  const activeChoice: StorageChoice = enrolled ? storageBackend : 'local';
  const oneDriveAvailable = oneDriveBackupEnabled && m365Connected;
  const busy = busyTarget !== null;

  // Default NEW setups to OneDrive (encrypted) whenever it is available and
  // the user hasn't explicitly picked a location yet. Preference-only — no
  // data moves until backup is actually turned on.
  useEffect(() => {
    if (
      !enrolled &&
      !storageChosen &&
      oneDriveAvailable &&
      storageBackend === 'app'
    ) {
      useBackupStore.getState().applyDefaultStorageBackend('onedrive');
    }
  }, [enrolled, storageChosen, oneDriveAvailable, storageBackend]);

  // OneDrive as a DESTINATION needs flag + connection; an enrollment already
  // pointing at OneDrive keeps its controls even if the flag later flips
  // (the user must always be able to move back or turn off).
  const storageChoices: StorageChoice[] = [
    'local',
    'app',
    ...(oneDriveAvailable || storageBackend === 'onedrive'
      ? (['onedrive'] as const)
      : []),
  ];

  const choiceLabel = (choice: StorageChoice): string =>
    choice === 'onedrive'
      ? t('backup.settings.storageOneDrive')
      : choice === 'app'
        ? t('backup.settings.storageApp')
        : t('backup.settings.storageLocal');

  const localSizeLabel = (): string => {
    const bytes = getConversationDataSize();
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  // ───────────────────────── storage location ─────────────────────────

  const handleChooseStorage = async (choice: StorageChoice) => {
    if (choice === activeChoice || busy) return;
    if (enrolled) {
      setPendingChoice(choice);
      return;
    }
    // Not enrolled: the choice is a cloud destination. Point the preference
    // there and hand over to the enroll flow (or the restore row, when a
    // backup already exists at that location).
    const store = useBackupStore.getState();
    store.setStorageBackend(choice as BackupBackend);
    const remote = await store.refreshRemoteStatus();
    if (remote?.exists !== true) {
      setBackupModalView('enroll-intro');
    }
  };

  /**
   * Common exit from cloud backup: pull-merge first, THEN remove the cloud
   * copy (with a disabled tombstone so other devices see "off", not
   * "wiped"). Aborts — nothing changed — when the pull can't confirm this
   * device holds the full corpus: deleting a remote another device may
   * have advanced would be silent data loss.
   */
  const retireCloudBackup = async (): Promise<boolean> => {
    const pulled = await syncNow();
    if (
      pulled === null ||
      (pulled.status !== 'ok' && pulled.status !== 'remote-missing')
    ) {
      toast.error(t('backup.settings.storageLocalSyncFailed'));
      return false;
    }
    const { remoteKeyEpoch, localKeyEpoch, clearEnrollment } =
      useBackupStore.getState();
    await disableBackupAt(
      storageBackend,
      Math.max(remoteKeyEpoch ?? 0, localKeyEpoch),
    );
    await clearMasterKey();
    clearEnrollment();
    useBackupStore.getState().setEncryptionMode('encrypted');
    void useBackupStore.getState().refreshRemoteStatus();
    return true;
  };

  const handleConfirmChoice = async () => {
    const target = pendingChoice;
    setPendingChoice(null);
    if (target === null) return;
    setBusyTarget(target);
    try {
      if (target === 'local') {
        if (await retireCloudBackup()) {
          toast.success(t('backup.settings.storageLocalSuccess'));
        }
        return;
      }
      if (plainMode) {
        // Leaving plain mode: there are no keys to carry over, so the move
        // retires the readable backup and re-enrolls (encrypted) at the
        // new location via the normal key-creation flow.
        if (await retireCloudBackup()) {
          useBackupStore.getState().setStorageBackend(target);
          setBackupModalView('enroll-intro');
        }
        return;
      }
      const keys = await resolveCryptoSource();
      if (keys === null || keys === 'plain') {
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
          t('backup.settings.storageSwitchSuccess', { count: result.pushed }),
        );
      }
    } catch {
      toast.error(
        target === 'local'
          ? t('backup.settings.storageLocalFailure')
          : t('backup.settings.storageSwitchFailure'),
      );
    } finally {
      setBusyTarget(null);
    }
  };

  // ───────────────────────── encryption mode ─────────────────────────

  const handleChooseMode = (mode: BackupEncryptionMode) => {
    if (mode === encryptionMode || busy) return;
    if (!enrolled) {
      // Preference only; the (warned) plain-enable confirm happens at
      // turn-on time.
      useBackupStore.getState().setEncryptionMode(mode);
      return;
    }
    setPendingMode(mode);
  };

  const handleConfirmMode = async () => {
    const mode = pendingMode;
    setPendingMode(null);
    if (mode === null) return;
    setBusyTarget('mode');
    try {
      if (mode === 'plain') {
        // Re-push the corpus as readable JSON over the encrypted backup
        // (epoch bump), then drop the key — nothing left to protect.
        const result = await pushFullBackup('plain', {
          overwriteLive: true,
          backend: 'onedrive',
        });
        await clearMasterKey();
        const store = useBackupStore.getState();
        store.setEncryptionMode('plain');
        store.setEnrolled(PLAIN_BACKUP_KEY_ID, result.epoch);
        toast.success(t('backup.settings.encryptionPlainSuccess'));
        return;
      }
      // plain → encrypted: retire the readable backup, then the normal
      // enroll flow creates a key and pushes fresh ciphertext.
      if (await retireCloudBackup()) {
        setBackupModalView('enroll-intro');
      }
    } catch {
      toast.error(t('backup.settings.encryptionSwitchFailure'));
    } finally {
      setBusyTarget(null);
    }
  };

  // ───────────────────── plain enable / plain restore ─────────────────────

  const handleTurnOn = () => {
    if (storageBackend === 'onedrive' && plainMode) {
      setShowPlainEnable(true);
      return;
    }
    setBackupModalView('enroll-intro');
  };

  const handleConfirmPlainEnable = async () => {
    setShowPlainEnable(false);
    setBusyTarget('onedrive');
    try {
      const result = await pushFullBackup('plain');
      const store = useBackupStore.getState();
      store.setEnrolled(PLAIN_BACKUP_KEY_ID, result.epoch);
      store.setSyncStatus('ok');
      toast.success(
        t('backup.settings.storageSwitchSuccess', { count: result.pushed }),
      );
    } catch {
      toast.error(t('backup.settings.storageSwitchFailure'));
    } finally {
      setBusyTarget(null);
    }
  };

  /** A plain remote needs no key — "restore" is a straight pull. */
  const handlePlainRestore = async () => {
    setBusyTarget(storageBackend);
    try {
      const store = useBackupStore.getState();
      store.setEncryptionMode('plain');
      store.setEnrolled(
        PLAIN_BACKUP_KEY_ID,
        store.remoteKeyEpoch ?? store.localKeyEpoch,
      );
      const result = await runSync(buildBackupSyncDeps('plain'));
      if (result.status === 'ok') {
        toast.success(t('backup.settings.backUpNowSuccess'));
      } else {
        useBackupStore.getState().clearEnrollment();
        toast.error(t('backup.settings.backUpNowFailure'));
      }
    } finally {
      setBusyTarget(null);
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

  const choiceIcon = (choice: StorageChoice) =>
    choice === 'onedrive' ? (
      <IconBrandOnedrive
        size={20}
        className="mt-0.5 shrink-0 text-gray-600 dark:text-gray-300"
      />
    ) : choice === 'app' ? (
      <IconServer
        size={20}
        className="mt-0.5 shrink-0 text-gray-600 dark:text-gray-300"
      />
    ) : (
      <IconDeviceLaptop
        size={20}
        className="mt-0.5 shrink-0 text-gray-600 dark:text-gray-300"
      />
    );

  const choiceDescription = (choice: StorageChoice): string =>
    choice === 'onedrive'
      ? t('backup.settings.storageOneDriveDescription')
      : choice === 'app'
        ? t('backup.settings.storageAppDescription')
        : t('backup.settings.storageLocalDescription');

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
              {plainMode && (
                <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                  {t('backup.settings.statusNotEncrypted')}
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

        {/* Storage location — this browser only, app storage, or the user's
            OneDrive app folder. The working copy always stays in this
            browser; the choice decides where (and whether) a cloud mirror
            exists. */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t('backup.settings.storageLocationTitle')}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('backup.settings.storageLocationDescription', {
              size: localSizeLabel(),
            })}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {storageChoices.map((choice) => {
              const active = activeChoice === choice;
              const spinning = busyTarget === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  onClick={() => void handleChooseStorage(choice)}
                  disabled={busy}
                  aria-pressed={active}
                  className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/30'
                      : 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'
                  } disabled:cursor-default`}
                >
                  {spinning ? (
                    <IconLoader2
                      size={20}
                      className="mt-0.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
                    />
                  ) : (
                    choiceIcon(choice)
                  )}
                  <span>
                    <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                      {choiceLabel(choice)}
                      {active && (
                        <span className="ml-1.5 text-xs font-normal text-blue-600 dark:text-blue-400">
                          {t('backup.settings.storageActive')}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                      {choiceDescription(choice)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {busy && (
            <p
              className="mt-2 text-xs text-gray-500 dark:text-gray-400"
              role="status"
            >
              {t('backup.settings.storageSwitching')}
            </p>
          )}

          {/* Encryption mode — OneDrive only. App storage is always
              encrypted; readable chat content never lands there. */}
          {storageBackend === 'onedrive' && (
            <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('backup.settings.encryptionTitle')}
              </p>
              <div className="mt-2 space-y-2">
                {(['encrypted', 'plain'] as const).map((mode) => {
                  const active = encryptionMode === mode;
                  return (
                    <label
                      key={mode}
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                        active
                          ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/30'
                          : 'border-gray-300 dark:border-gray-600'
                      } ${busy ? 'opacity-60' : ''}`}
                    >
                      <input
                        type="radio"
                        name="backup-encryption-mode"
                        className="mt-0.5"
                        checked={active}
                        disabled={busy}
                        onChange={() => handleChooseMode(mode)}
                      />
                      <span>
                        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                          {mode === 'encrypted'
                            ? t('backup.settings.encryptionEncrypted')
                            : t('backup.settings.encryptionPlain')}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                          {mode === 'encrypted'
                            ? t(
                                'backup.settings.encryptionEncryptedDescription',
                              )
                            : t('backup.settings.encryptionPlainDescription')}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {plainMode && (
                <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                  {t('backup.settings.encryptionPlainWarning')}
                </p>
              )}
            </div>
          )}
        </div>

        {!enrolled && (
          <div className="space-y-4">
            {/* A live remote backup means the right entry point is restoring
                it (with its key when encrypted) — a fresh enroll here could
                never push over a foreign-key manifest and would dead-end. */}
            {remoteExists !== true && (
              <button
                type="button"
                onClick={handleTurnOn}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
              >
                {busy ? (
                  <IconLoader2 size={16} className="animate-spin" />
                ) : (
                  <IconShieldLock size={16} />
                )}
                {t('backup.settings.turnOn')}
              </button>
            )}

            {remoteExists === true && (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {t('backup.settings.restoreTitle')}
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {isPlainBackupKeyId(remoteKeyId)
                    ? t('backup.settings.restorePlainDescription')
                    : t('backup.settings.restoreDescription')}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    isPlainBackupKeyId(remoteKeyId)
                      ? void handlePlainRestore()
                      : setBackupModalView('restore')
                  }
                  disabled={busy}
                  className={`${actionButtonClasses} mt-2`}
                >
                  {busy && <IconLoader2 size={16} className="animate-spin" />}
                  {t('backup.settings.restore')}
                </button>
              </div>
            )}
          </div>
        )}

        {enrolled && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleBackUpNow}
              disabled={isBackingUp || busy || status === 'syncing'}
              className={actionButtonClasses}
            >
              {isBackingUp || status === 'syncing' ? (
                <IconLoader2 size={16} className="animate-spin" />
              ) : (
                <IconCloudUpload size={16} />
              )}
              {t('backup.settings.backUpNow')}
            </button>
            {!plainMode && (
              <>
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
              </>
            )}
          </div>
        )}
      </div>

      {/* Storage move confirmations. "This device only" is a migration —
          chats stay; only the cloud mirror is retired. */}
      <ConfirmDialog
        isOpen={pendingChoice !== null}
        title={
          pendingChoice === 'local'
            ? t('backup.settings.storageLocalConfirmTitle')
            : t('backup.settings.storageSwitchConfirmTitle', {
                target: pendingChoice ? choiceLabel(pendingChoice) : '',
              })
        }
        message={
          pendingChoice === 'local'
            ? t('backup.settings.storageLocalConfirmMessage', {
                size: localSizeLabel(),
              })
            : plainMode
              ? t('backup.settings.storageSwitchEncryptFirstMessage', {
                  target: pendingChoice ? choiceLabel(pendingChoice) : '',
                })
              : t('backup.settings.storageSwitchConfirmMessage', {
                  target: pendingChoice ? choiceLabel(pendingChoice) : '',
                })
        }
        confirmLabel={
          pendingChoice === 'local'
            ? t('backup.settings.storageLocalConfirmAction')
            : t('backup.settings.storageSwitchAction')
        }
        onConfirm={handleConfirmChoice}
        onCancel={() => setPendingChoice(null)}
      />

      {/* Encryption-mode change: turning encryption OFF is the dangerous
          direction and gets the explicit warning. */}
      <ConfirmDialog
        isOpen={pendingMode !== null}
        title={
          pendingMode === 'plain'
            ? t('backup.settings.encryptionPlainConfirmTitle')
            : t('backup.settings.encryptionEncryptConfirmTitle')
        }
        message={
          pendingMode === 'plain'
            ? t('backup.settings.encryptionPlainConfirmMessage')
            : t('backup.settings.encryptionEncryptConfirmMessage')
        }
        confirmLabel={
          pendingMode === 'plain'
            ? t('backup.settings.encryptionPlainConfirmAction')
            : t('backup.settings.encryptionEncryptConfirmAction')
        }
        confirmVariant={pendingMode === 'plain' ? 'danger' : undefined}
        onConfirm={handleConfirmMode}
        onCancel={() => setPendingMode(null)}
      />

      {/* Turning ON an unencrypted backup — warned, explicit. */}
      <ConfirmDialog
        isOpen={showPlainEnable}
        title={t('backup.settings.encryptionPlainConfirmTitle')}
        message={t('backup.settings.encryptionPlainConfirmMessage')}
        confirmLabel={t('backup.settings.encryptionPlainConfirmAction')}
        confirmVariant="danger"
        onConfirm={handleConfirmPlainEnable}
        onCancel={() => setShowPlainEnable(false)}
      />
    </div>
  );
};
