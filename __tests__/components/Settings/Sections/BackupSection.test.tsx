import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

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

// Keep disableBackupAt real (the turn-off tests observe its api calls);
// the switch orchestration has its own unit suite (backupOps.switch.test).
vi.mock('@/lib/utils/app/backup/backupOps', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/utils/app/backup/backupOps')>();
  return { ...actual, switchBackupBackend: mocks.switchBackupBackend };
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
    useSettingsStore.setState({ m365Connected: false });
    useBackupStore.setState({
      storageBackend: 'app',
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
  });

  describe('danger zone: turn off & delete', () => {
    it('runs the disable composition only after the red confirm', async () => {
      setEnrolled();
      useBackupStore.setState({ remoteKeyEpoch: 3 });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.turnOffDelete'));
      // Nothing destructive before confirming.
      expect(mocks.deleteBackup).not.toHaveBeenCalled();
      expect(
        screen.getByText('backup.settings.turnOffConfirmTitle'),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByText('backup.settings.turnOffConfirmAction'));

      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          'backup.settings.turnOffSuccess',
        ),
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

      fireEvent.click(screen.getByText('backup.settings.turnOffDelete'));
      fireEvent.click(screen.getByText('common.cancel'));

      expect(mocks.deleteBackup).not.toHaveBeenCalled();
      expect(mocks.clearMasterKey).not.toHaveBeenCalled();
      expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled');
      expect(
        screen.queryByText('backup.settings.turnOffConfirmTitle'),
      ).not.toBeInTheDocument();
    });

    it('keeps enrollment and toasts failure when the server delete fails', async () => {
      setEnrolled();
      mocks.deleteBackup.mockRejectedValue(new Error('storage down'));
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.turnOffDelete'));
      fireEvent.click(screen.getByText('backup.settings.turnOffConfirmAction'));

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          'backup.settings.turnOffFailure',
        ),
      );
      expect(mocks.putManifest).not.toHaveBeenCalled();
      expect(mocks.clearMasterKey).not.toHaveBeenCalled();
      expect(useBackupStore.getState().enrollmentStatus).toBe('enrolled');
    });
  });

  describe('storage location', () => {
    it('hides the storage card without an M365 connection (app backend)', () => {
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.queryByText('backup.settings.storageLocationTitle'),
      ).not.toBeInTheDocument();
    });

    it('shows both options when M365 is connected', () => {
      useSettingsStore.setState({ m365Connected: true });
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.storageLocationTitle'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageApp'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('backup.settings.storageOneDrive'),
      ).toBeInTheDocument();
    });

    it('keeps the card visible on the onedrive backend even if M365 disconnects', () => {
      useBackupStore.setState({ storageBackend: 'onedrive' });
      setEnrolled();
      render(<BackupSection />);
      expect(
        screen.getByText('backup.settings.storageLocationTitle'),
      ).toBeInTheDocument();
    });

    it('when not enrolled, choosing a backend just flips the preference', () => {
      useSettingsStore.setState({ m365Connected: true });
      render(<BackupSection />);

      fireEvent.click(screen.getByText('backup.settings.storageOneDrive'));

      expect(useBackupStore.getState().storageBackend).toBe('onedrive');
      expect(mocks.switchBackupBackend).not.toHaveBeenCalled();
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
});
