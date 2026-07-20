import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';

import { getBackupKeys } from '@/client/services/backup/keystore';
import type { SyncStatus } from '@/lib/services/backup/types';

import { pushFullBackup } from '@/lib/utils/app/backup/backupOps';

import { BackupSyncBanner } from '@/components/Backup/BackupSyncBanner';

import { useBackupStore } from '@/client/stores/backupStore';
import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ showChatbar: false }),
}));

vi.mock('@/client/services/backup/keystore', () => ({
  getBackupKeys: vi.fn(),
}));

vi.mock('@/lib/utils/app/backup/backupOps', () => ({
  pushFullBackup: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const KEYS = { encKey: {} as CryptoKey, keyId: 'aabbccddeeff0011' };

function setBannerState(syncStatus: SyncStatus, collapsed = false) {
  useBackupStore.setState({
    flagEnabled: true,
    syncStatus,
    bannerCollapsed: collapsed,
  });
}

describe('BackupSyncBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ backupModalView: null });
    useBackupStore.setState({
      flagEnabled: true,
      syncStatus: 'idle',
      bannerCollapsed: false,
      enrollmentStatus: 'enrolled',
      localKeyId: KEYS.keyId,
      localKeyEpoch: 1,
    });
  });

  it('renders nothing when the flag mirror is off, even in a mismatch state', () => {
    useBackupStore.setState({
      flagEnabled: false,
      syncStatus: 'key-out-of-date',
    });
    const { container } = render(<BackupSyncBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['idle', 'syncing', 'ok', 'error'] as SyncStatus[])(
    'stays silent for %s (same-key races never surface a banner)',
    (status) => {
      setBannerState(status);
      const { container } = render(<BackupSyncBanner />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('shows the amber key-out-of-date banner with both actions', () => {
    setBannerState('key-out-of-date');
    render(<BackupSyncBanner />);
    expect(screen.getByText('banner.keyMismatchTitle')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'banner.enterNewKey' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'banner.resetBackup' }),
    ).toBeInTheDocument();
  });

  it('Enter new key opens the enter-key modal view', () => {
    setBannerState('key-out-of-date');
    render(<BackupSyncBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'banner.enterNewKey' }));
    expect(useUIStore.getState().backupModalView).toBe('enter-key');
  });

  it('Reset backup asks for confirmation, then pushes a full overwrite', async () => {
    vi.mocked(getBackupKeys).mockResolvedValue(KEYS);
    vi.mocked(pushFullBackup).mockResolvedValue({
      keyId: KEYS.keyId,
      epoch: 5,
      version: 9,
      etag: '"e"',
      pushed: 2,
    });
    setBannerState('key-out-of-date');
    render(<BackupSyncBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'banner.resetBackup' }));
    expect(screen.getByText('banner.resetConfirmBody')).toBeInTheDocument();
    expect(pushFullBackup).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'banner.resetConfirmAction' }),
    );
    await waitFor(() =>
      expect(pushFullBackup).toHaveBeenCalledWith(KEYS, {
        overwriteLive: true,
      }),
    );
    await waitFor(() =>
      expect(useBackupStore.getState().syncStatus).toBe('ok'),
    );
    expect(useBackupStore.getState().localKeyEpoch).toBe(5);
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows the gray remote-missing banner and re-creates the backup', async () => {
    vi.mocked(getBackupKeys).mockResolvedValue(KEYS);
    vi.mocked(pushFullBackup).mockResolvedValue({
      keyId: KEYS.keyId,
      epoch: 2,
      version: 1,
      etag: '"e"',
      pushed: 4,
    });
    setBannerState('remote-missing');
    render(<BackupSyncBanner />);

    expect(screen.getByText('banner.remoteMissingTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'banner.backUpAgain' }));
    await waitFor(() =>
      expect(pushFullBackup).toHaveBeenCalledWith(KEYS, {
        overwriteLive: false,
      }),
    );
    await waitFor(() =>
      expect(useBackupStore.getState().syncStatus).toBe('ok'),
    );
  });

  it('surfaces failures as an error toast without changing state', async () => {
    vi.mocked(getBackupKeys).mockResolvedValue(KEYS);
    vi.mocked(pushFullBackup).mockRejectedValue(new Error('boom'));
    setBannerState('remote-missing');
    render(<BackupSyncBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'banner.backUpAgain' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(useBackupStore.getState().syncStatus).toBe('remote-missing');
  });

  it('dismiss collapses the banner', () => {
    setBannerState('key-out-of-date');
    const { container } = render(<BackupSyncBanner />);
    fireEvent.click(screen.getByLabelText('banner.dismiss'));
    expect(useBackupStore.getState().bannerCollapsed).toBe(true);
    expect(container).toBeEmptyDOMElement();
  });

  it('routes to enter-key when enrolled but the keystore is empty', async () => {
    vi.mocked(getBackupKeys).mockResolvedValue(null);
    setBannerState('remote-missing');
    render(<BackupSyncBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'banner.backUpAgain' }));
    await waitFor(() =>
      expect(useUIStore.getState().backupModalView).toBe('enter-key'),
    );
    expect(pushFullBackup).not.toHaveBeenCalled();
  });
});
