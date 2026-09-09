import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { PLAIN_BACKUP_KEY_ID } from '@/lib/services/backup/plainCrypto';
import type { SyncResult, SyncStatus } from '@/lib/services/backup/types';

import { BackupSection } from '@/components/Settings/Sections/BackupSection';

import { useBackupStore } from '@/client/stores/backupStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncNow: vi.fn<() => Promise<unknown>>(),
  hook: {
    status: 'idle' as string,
    lastBackupAt: null as string | null,
    keyMismatch: false,
  },
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastPlain: vi.fn(),
  deleteBackup: vi.fn<() => Promise<void>>(),
  putManifest: vi.fn<() => Promise<{ etag: string }>>(),
  getManifest: vi.fn<() => Promise<unknown>>(),
  clearMasterKey: vi.fn<() => Promise<void>>(),
  getBackupKeys: vi.fn<() => Promise<unknown>>(),
  switchBackupBackend: vi.fn<() => Promise<unknown>>(),
  pushFullBackup: vi.fn<() => Promise<unknown>>(),
  runSync: vi.fn<() => Promise<unknown>>(),
}));

// The hook owns trigger wiring + session gating — the section only needs its
// {status, lastBackupAt, syncNow} surface.
vi.mock('@/client/hooks/backup/useBackupSync', () => ({
  useBackupSync: () => ({ ...mocks.hook, syncNow: mocks.syncNow }),
}));

vi.mock('react-hot-toast', () => ({
  // Callable default (bare toast(...) is the warning variant) with the
  // success/error methods attached, mirroring the real API surface.
  default: Object.assign(mocks.toastPlain, {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  }),
}));

vi.mock('@/lib/services/backup/backupApiClient', () => ({
  createBackupApiClient: () => ({
    deleteBackup: mocks.deleteBackup,
    putManifest: mocks.putManifest,
    getManifest: mocks.getManifest,
  }),
}));

vi.mock('@/client/services/backup/keystore', () => ({
  clearMasterKey: mocks.clearMasterKey,
  getBackupKeys: mocks.getBackupKeys,
}));

// Keep disableBackupAt + resolveCryptoSource real (the retire flow asserts
// on the api-client mocks); orchestration helpers with their own unit
// suites are stubbed.
vi.mock('@/lib/utils/app/backup/backupOps', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/utils/app/backup/backupOps')>();
  return {
    ...actual,
    switchBackupBackend: mocks.switchBackupBackend,
    pushFullBackup: mocks.pushFullBackup,
  };
});

vi.mock('@/lib/services/backup/syncEngine', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/backup/syncEngine')>();
  return { ...actual, runSync: mocks.runSync };
});

// Override the global setup mock so interpolated params are observable:
// t('a.b', {x: 1}) renders as "a.b|1".
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const translate = (
      key: string,
      params?: Record<string, string | number>,
    ) => (params ? `${key}|${Object.values(params).join(',')}` : key);
    translate.has = () => false;
    translate.rich = (key: string) => key;
    return translate;
  },
  useFormatter: () => ({
    relativeTime: () => '2 hours ago',
    dateTime: () => '',
    number: () => '',
  }),
}));

const okResult: SyncResult = {
  status: 'ok',
  pushed: 1,
  pulled: 0,
  deleted: 0,
  conflictRetries: 0,
};

function setEnrolled(overrides: Partial<{ localKeyId: string }> = {}) {
  useBackupStore.setState({
    enrollmentStatus: 'enrolled',
    localKeyId: overrides.localKeyId ?? '00aabbccddeef789',
    localKeyEpoch: 2,
  });
}

function setEnrolledPlain() {
  useBackupStore.setState({
    enrollmentStatus: 'enrolled',
    storageBackend: 'onedrive',
    encryptionMode: 'plain',
    localKeyId: PLAIN_BACKUP_KEY_ID,
    localKeyEpoch: 2,
  });
}

describe('BackupSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hook.status = 'idle';
    mocks.hook.lastBackupAt = null;
    mocks.syncNow.mockResolvedValue(okResult);
    mocks.deleteBackup.mockResolvedValue(undefined);
    mocks.putManifest.mockResolvedValue({ etag: 'etag-1' });
    mocks.getManifest.mockResolvedValue(null);
    mocks.clearMasterKey.mockResolvedValue(undefined);
    mocks.getBackupKeys.mockResolvedValue({ keyId: '00aabbccddeef789' });
    mocks.switchBackupBackend.mockResolvedValue({
      pushed: 2,
      cleanupFailed: false,
    });
    mocks.pushFullBackup.mockResolvedValue({
      keyId: PLAIN_BACKUP_KEY_ID,
      epoch: 1,
      version: 1,
      etag: '"e"',
      pushed: 2,
    });
    mocks.runSync.mockResolvedValue(okResult);
    useSettingsStore.setState({ m365Connected: false });
    useBackupStore.setState({
      storageBackend: 'app',
      // Explicit choice by default so the OneDrive default-nudge effect
      // stays out of unrelated tests.
      storageChosen: true,
      encryptionMode: 'encrypted',
      enrollmentStatus: 'unset',
      localKeyId: null,
      localKeyEpoch: 1,
      lastSyncedVersion: null,
      lastSyncedEtag: null,
      lastBackupAt: null,
      lastSyncError: null,
      syncStatus: 'idle',
      remoteExists: null,
      remoteKeyId: null,
      remoteKeyEpoch: null,
    });
    useUIStore.setState({ backupModalView: null });
  });

  describe('off state', () => {
    it('shows Off + Turn on, which opens the enroll-intro modal view', () => {
      render(<BackupSection />);

      expect(screen.getByText('backup.settings.statusOff')).toBeInTheDocument();
      expect(
        screen.queryByText('backup.settings.backUpNow'),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('backup.settings.turnOn'));
      expect(useUIStore.getState().backupModalView).toBe('enroll-intro');
    });

    it('offers no restore row when remote existence is unknown or absent', () => {
      render(<BackupSection />);
      expect(
        screen.queryByText('backup.settings.restore'),
      ).not.toBeInTheDocument();
    });

    it('shows the restore row when a remote backup exists without a local key', () => {
      useBackupStore.setState({
        enrollmentStatus: 'declined',
        remoteExists: true,
      });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.restore'));
      expect(useUIStore.getState().backupModalView).toBe('restore');
    });

    it('restores a PLAIN remote with a straight pull — no key modal', async () => {
      useBackupStore.setState({
        storageBackend: 'onedrive',
        remoteExists: true,
        remoteKeyId: PLAIN_BACKUP_KEY_ID,
        remoteKeyEpoch: 3,
      });
      render(<BackupSection />);

      expect(
        screen.getByText('backup.settings.restorePlainDescription'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByText('backup.settings.restore'));

      await waitFor(() => expect(mocks.runSync).toHaveBeenCalledTimes(1));
      expect(useUIStore.getState().backupModalView).toBeNull();
      const state = useBackupStore.getState();
      expect(state.enrollmentStatus).toBe('enrolled');
      expect(state.localKeyId).toBe(PLAIN_BACKUP_KEY_ID);
      expect(state.encryptionMode).toBe('plain');
    });
  });

  describe('on state', () => {
    it('shows status card with key tail, last-backup time, and sync state line', () => {
      setEnrolled({ localKeyId: '00aabbccddeef789' });
      mocks.hook.status = 'ok';
      mocks.hook.lastBackupAt = '2026-07-17T10:00:00.000Z';
      render(<BackupSection />);

      expect(screen.getByText('backup.settings.statusOn')).toBeInTheDocument();
      // Fingerprint tail: last 4 chars of the keyId, uppercased.
      expect(
        screen.getByText('backup.settings.keyFingerprint|F789'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.lastBackup|2 hours ago'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.syncState.ok'),
      ).toBeInTheDocument();
      // Enroll affordances are gone.
      expect(
        screen.queryByText('backup.settings.turnOn'),
      ).not.toBeInTheDocument();
    });

    it.each<[SyncStatus, string]>([
      ['key-out-of-date', 'backup.settings.syncState.keyOutOfDate'],
      ['remote-missing', 'backup.settings.syncState.remoteMissing'],
    ])('maps %s to its status line', (status, expected) => {
      setEnrolled();
      mocks.hook.status = status;
      render(<BackupSection />);
      expect(screen.getByText(expected)).toBeInTheDocument();
    });

    it('surfaces lastSyncError under an error status', () => {
      setEnrolled();
      mocks.hook.status = 'error';
      useBackupStore.setState({ lastSyncError: 'boom from engine' });
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.syncState.error'),
      ).toBeInTheDocument();
      expect(screen.getByText('boom from engine')).toBeInTheDocument();
    });

    it('Back up now calls syncNow and toasts success on ok', async () => {
      setEnrolled();
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.backUpNow'));

      await waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          'backup.settings.backUpNowSuccess',
        ),
      );
      expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it.each([
      ['error result', { ...okResult, status: 'error' as const }],
      ['null (gate not ready / keystore empty)', null],
    ])('Back up now toasts failure on %s', async (_label, result) => {
      setEnrolled();
      mocks.syncNow.mockResolvedValue(result);
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.backUpNow'));

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          'backup.settings.backUpNowFailure',
        ),
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('disables Back up now while a sync is already running', () => {
      setEnrolled();
      mocks.hook.status = 'syncing';
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.backUpNow').closest('button'),
      ).toBeDisabled();
    });

    it('View recovery key opens the view-key modal view', () => {
      setEnrolled();
      render(<BackupSection />);
      fireEvent.click(screen.getByText('backup.settings.viewKey'));
      expect(useUIStore.getState().backupModalView).toBe('view-key');
    });

    it('Change recovery key opens the rotate-confirm modal view', () => {
      setEnrolled();
      render(<BackupSection />);
      fireEvent.click(screen.getByText('backup.settings.changeKey'));
      expect(useUIStore.getState().backupModalView).toBe('rotate-confirm');
    });

    it('plain mode hides key actions and flags the unencrypted state', () => {
      setEnrolledPlain();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.statusNotEncrypted'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('backup.settings.viewKey'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('backup.settings.changeKey'),
      ).not.toBeInTheDocument();
      // No fingerprint line for the sentinel key id.
      expect(
        screen.queryByText(/backup\.settings\.keyFingerprint/),
      ).not.toBeInTheDocument();
    });
  });

  describe('switch to this device only', () => {
    it('pulls first, then retires the cloud copy after the confirm', async () => {
      setEnrolled();
      useBackupStore.setState({ remoteKeyEpoch: 3 });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageLocal'));
      // Nothing destructive before confirming.
      expect(mocks.deleteBackup).not.toHaveBeenCalled();
      expect(
        screen.getByText('backup.settings.storageLocalConfirmTitle'),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByText('backup.settings.storageLocalConfirmAction'),
      );

      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          'backup.settings.storageLocalSuccess',
        ),
      );

      // Pull-merge BEFORE the wipe so remote-only conversations land here.
      expect(mocks.syncNow).toHaveBeenCalledTimes(1);
      expect(mocks.syncNow.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.deleteBackup.mock.invocationCallOrder[0],
      );

      expect(mocks.deleteBackup).toHaveBeenCalledTimes(1);
      // Tombstone manifest: fresh create (version 1, no If-Match), keyId null,
      // epoch bumped past the highest known epoch (remote 3 > local 2).
      expect(mocks.putManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          schemaVersion: 1,
          keyId: null,
          disabled: true,
          epoch: 4,
          version: 1,
          folders: null,
          conversations: {},
        }),
        { ifMatchEtag: null },
      );
      // Wipe before tombstone write.
      expect(mocks.deleteBackup.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.putManifest.mock.invocationCallOrder[0],
      );
      expect(mocks.clearMasterKey).toHaveBeenCalledTimes(1);
      expect(useBackupStore.getState().enrollmentStatus).toBe('unset');
      expect(useBackupStore.getState().localKeyId).toBeNull();
    });

    it('cancelling the confirm leaves everything untouched', () => {
      setEnrolled();
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageLocal'));
      fireEvent.click(screen.getByText('common.cancel'));

      expect(mocks.deleteBackup).not.toHaveBeenCalled();
      expect(mocks.clearMasterKey).not.toHaveBeenCalled();
      expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled');
      expect(
        screen.queryByText('backup.settings.storageLocalConfirmTitle'),
      ).not.toBeInTheDocument();
    });

    it('aborts the retire when the pre-pull cannot confirm a full local copy', async () => {
      setEnrolled();
      mocks.syncNow.mockResolvedValue({ ...okResult, status: 'error' });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageLocal'));
      fireEvent.click(
        screen.getByText('backup.settings.storageLocalConfirmAction'),
      );

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          'backup.settings.storageLocalSyncFailed',
        ),
      );
      expect(mocks.deleteBackup).not.toHaveBeenCalled();
      expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled');
    });

    it('keeps enrollment and toasts failure when the server delete fails', async () => {
      setEnrolled();
      mocks.deleteBackup.mockRejectedValue(new Error('storage down'));
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageLocal'));
      fireEvent.click(
        screen.getByText('backup.settings.storageLocalConfirmAction'),
      );

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          'backup.settings.storageLocalFailure',
        ),
      );
      expect(mocks.putManifest).not.toHaveBeenCalled();
      expect(mocks.clearMasterKey).not.toHaveBeenCalled();
      expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled');
    });
  });

  describe('storage location', () => {
    it('always shows local + app; OneDrive only with an M365 connection', () => {
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.storageLocationTitle'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageLocal'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageApp'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('backup.settings.storageOneDrive'),
      ).not.toBeInTheDocument();
    });

    it('shows all three options when M365 is connected', () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.storageLocal'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageApp'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageOneDrive'),
      ).toBeInTheDocument();
    });

    it('keeps the OneDrive option on the onedrive backend even if M365 disconnects', () => {
      useBackupStore.setState({ storageBackend: 'onedrive' });
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.storageOneDrive'),
      ).toBeInTheDocument();
    });

    it('when not enrolled, choosing a destination flips the preference and starts enrollment', async () => {
      useSettingsStore.setState({ m365Connected: true });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageOneDrive'));

      await waitFor(() =>
        expect(useBackupStore.getState().storageBackend).toBe('onedrive'),
      );
      // No remote at the new location → straight into the enroll flow.
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );
      expect(mocks.switchBackupBackend).not.toHaveBeenCalled();
    });

    it('defaults NEW setups to OneDrive when available and nothing was chosen', async () => {
      useSettingsStore.setState({ m365Connected: true });
      useBackupStore.setState({ storageChosen: false });
      render(<BackupSection />);

      await waitFor(() =>
        expect(useBackupStore.getState().storageBackend).toBe('onedrive'),
      );
      // Still a default, not a choice — availability changes may re-adapt.
      expect(useBackupStore.getState().storageChosen).toBe(false);
    });

    it('never overrides an explicit choice with the OneDrive default', () => {
      useSettingsStore.setState({ m365Connected: true });
      useBackupStore.setState({ storageChosen: true });
      render(<BackupSection />);
      expect(useBackupStore.getState().storageBackend).toBe('app');
    });

    it('when enrolled, switching asks for confirmation then migrates', async () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolled();
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageOneDrive'));
      // Preference unchanged until the migration actually succeeds.
      expect(useBackupStore.getState().storageBackend).toBe('app');

      fireEvent.click(screen.getByText('backup.settings.storageSwitchAction'));

      await waitFor(() =>
        expect(mocks.switchBackupBackend).toHaveBeenCalledWith(
          'onedrive',
          expect.objectContaining({ keyId: '00aabbccddeef789' }),
        ),
      );
      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          'backup.settings.storageSwitchSuccess|2',
        ),
      );
    });

    it('surfaces a cleanup warning when the old location could not be wiped', async () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolled();
      mocks.switchBackupBackend.mockResolvedValue({
        pushed: 2,
        cleanupFailed: true,
      });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageOneDrive'));
      fireEvent.click(screen.getByText('backup.settings.storageSwitchAction'));

      await waitFor(() =>
        expect(mocks.toastPlain).toHaveBeenCalledWith(
          'backup.settings.storageSwitchCleanupWarning',
          expect.anything(),
        ),
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
    });
  });

  describe('encryption mode', () => {
    it('shows the mode choice only for the OneDrive backend', () => {
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.queryByText('backup.settings.encryptionTitle'),
      ).not.toBeInTheDocument();
    });

    it('turn-on in plain mode warns first, then pushes readable files', async () => {
      useSettingsStore.setState({ m365Connected: true });
      useBackupStore.setState({
        storageBackend: 'onedrive',
        encryptionMode: 'plain',
      });
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.encryptionPlainWarning'),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByText('backup.settings.turnOn'));
      // Warned confirm instead of the key-creation modal.
      expect(useUIStore.getState().backupModalView).toBeNull();
      fireEvent.click(
        screen.getByText('backup.settings.encryptionPlainConfirmAction'),
      );

      await waitFor(() =>
        expect(mocks.pushFullBackup).toHaveBeenCalledWith('plain'),
      );
      await waitFor(() =>
        expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled'),
      );
      expect(useBackupStore.getState().localKeyId).toBe(PLAIN_BACKUP_KEY_ID);
    });

    it('encrypted → plain re-pushes readable files and drops the key', async () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolled();
      useBackupStore.setState({ storageBackend: 'onedrive' });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.encryptionPlain'));
      expect(
        screen.getByText('backup.settings.encryptionPlainConfirmTitle'),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByText('backup.settings.encryptionPlainConfirmAction'),
      );

      await waitFor(() =>
        expect(mocks.pushFullBackup).toHaveBeenCalledWith('plain', {
          overwriteLive: true,
          backend: 'onedrive',
        }),
      );
      await waitFor(() =>
        expect(useBackupStore.getState().encryptionMode).toBe('plain'),
      );
      expect(mocks.clearMasterKey).toHaveBeenCalled();
      expect(useBackupStore.getState().localKeyId).toBe(PLAIN_BACKUP_KEY_ID);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'backup.settings.encryptionPlainSuccess',
      );
    });

    it('plain → encrypted retires the readable backup and opens enrollment', async () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolledPlain();
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.encryptionEncrypted'));
      fireEvent.click(
        screen.getByText('backup.settings.encryptionEncryptConfirmAction'),
      );

      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );
      // Readable copy is gone; a fresh encrypted enroll follows.
      expect(mocks.deleteBackup).toHaveBeenCalled();
      expect(useBackupStore.getState().encryptionMode).toBe('encrypted');
      expect(useBackupStore.getState().enrollmentStatus).toBe('unset');
    });

    it('leaving plain mode for another backend requires encrypting first', async () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolledPlain();
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageApp'));
      expect(
        screen.getByText(
          'backup.settings.storageSwitchEncryptFirstMessage|backup.settings.storageApp',
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByText('backup.settings.storageSwitchAction'));

      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );
      expect(mocks.deleteBackup).toHaveBeenCalled();
      expect(useBackupStore.getState().storageBackend).toBe('app');
      expect(mocks.switchBackupBackend).not.toHaveBeenCalled();
    });
  });
});
