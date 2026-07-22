import { act, render, screen, waitFor } from '@testing-library/react';

import { loadMasterKey } from '@/client/services/backup/keystore';

import { BackupModals } from '@/components/Backup/BackupModals';

import type { RemoteBackupStatus } from '@/client/stores/backupStore';
import { useBackupStore } from '@/client/stores/backupStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const sessionState: { status: string } = { status: 'authenticated' };
vi.mock('next-auth/react', () => ({
  useSession: () => sessionState,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The sync trigger hook is the stores slice's, tested on its own — a no-op
// here so mounting the host never touches the network.
vi.mock('@/client/hooks/backup/useBackupSync', () => ({
  useBackupSync: vi.fn(() => ({
    status: 'idle',
    lastBackupAt: null,
    keyMismatch: false,
    syncNow: vi.fn(),
  })),
}));

vi.mock('@/client/services/backup/keystore', () => ({
  loadMasterKey: vi.fn(),
  getBackupKeys: vi.fn(),
  saveMasterKey: vi.fn(() => Promise.resolve()),
  resetBackupKeyCache: vi.fn(),
}));

vi.mock('@/lib/services/backup/syncEngine', () => ({
  runSync: vi.fn(),
  restoreFromRemote: vi.fn(),
}));

vi.mock('@/lib/utils/app/backup/backupOps', () => ({
  buildBackupSyncDeps: vi.fn(),
  pushFullBackup: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const refreshRemoteStatus = vi.fn<() => Promise<RemoteBackupStatus | null>>();

function remoteStatus(
  overrides: Partial<RemoteBackupStatus> = {},
): RemoteBackupStatus {
  return {
    exists: false,
    keyId: null,
    epoch: null,
    disabled: false,
    ...overrides,
  };
}

describe('BackupModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    sessionState.status = 'authenticated';
    useUIStore.setState({ backupModalView: null, isTermsModalOpen: false });
    useConversationStore.setState({ isLoaded: true });
    useBackupStore.setState({
      enrollmentStatus: 'unset',
      localKeyId: null,
      flagEnabled: false,
      remoteExists: null,
      remoteKeyId: null,
      remoteKeyEpoch: null,
      refreshRemoteStatus,
    });
    refreshRemoteStatus.mockResolvedValue(remoteStatus());
    vi.mocked(loadMasterKey).mockResolvedValue(null);
  });

  describe('fail-closed flag gate', () => {
    it('renders nothing when the flag is unserved (undefined)', () => {
      const { container } = render(<BackupModals />);
      expect(container).toBeEmptyDOMElement();
      expect(useBackupStore.getState().flagEnabled).toBe(false);
      expect(refreshRemoteStatus).not.toHaveBeenCalled();
    });

    it('renders nothing when the flag is explicitly false', () => {
      mockFlags.enableEncryptedBackups = false;
      const { container } = render(<BackupModals />);
      expect(container).toBeEmptyDOMElement();
      expect(useBackupStore.getState().flagEnabled).toBe(false);
    });

    it('mirrors an explicit true into backupStore and mounts the host', async () => {
      mockFlags.enableEncryptedBackups = true;
      render(<BackupModals />);
      await waitFor(() =>
        expect(useBackupStore.getState().flagEnabled).toBe(true),
      );
    });
  });

  describe('auto-prompt matrix (flag on, authenticated, rehydrated)', () => {
    beforeEach(() => {
      mockFlags.enableEncryptedBackups = true;
    });

    it('opens the restore prompt when a remote backup exists and no local key', async () => {
      refreshRemoteStatus.mockResolvedValue(
        remoteStatus({ exists: true, keyId: 'abcd', epoch: 2 }),
      );
      render(<BackupModals />);
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('restore'),
      );
      expect(screen.getByText('restore.promptBody')).toBeInTheDocument();
    });

    it('restore outranks a previous decline', async () => {
      useBackupStore.setState({ enrollmentStatus: 'declined' });
      refreshRemoteStatus.mockResolvedValue(
        remoteStatus({ exists: true, keyId: 'abcd', epoch: 2 }),
      );
      render(<BackupModals />);
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('restore'),
      );
    });

    it('opens the enroll intro for an unset user with no remote backup', async () => {
      render(<BackupModals />);
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );
      expect(screen.getByText('intro.title')).toBeInTheDocument();
    });

    it('never nags a declined user when there is nothing to restore', async () => {
      useBackupStore.setState({ enrollmentStatus: 'declined' });
      render(<BackupModals />);
      await waitFor(() => expect(refreshRemoteStatus).toHaveBeenCalled());
      await act(async () => {});
      expect(useUIStore.getState().backupModalView).toBeNull();
    });

    it('stays quiet for an enrolled device that still holds its key', async () => {
      useBackupStore.setState({
        enrollmentStatus: 'enrolled',
        localKeyId: 'abcd',
      });
      vi.mocked(loadMasterKey).mockResolvedValue(new Uint8Array(32));
      refreshRemoteStatus.mockResolvedValue(
        remoteStatus({ exists: true, keyId: 'abcd', epoch: 1 }),
      );
      render(<BackupModals />);
      await waitFor(() => expect(refreshRemoteStatus).toHaveBeenCalled());
      await act(async () => {});
      expect(useUIStore.getState().backupModalView).toBeNull();
    });

    it('does nothing while the session is not authenticated', async () => {
      sessionState.status = 'loading';
      render(<BackupModals />);
      await act(async () => {});
      expect(refreshRemoteStatus).not.toHaveBeenCalled();
      expect(useUIStore.getState().backupModalView).toBeNull();
    });

    it('does nothing before the conversation store has rehydrated', async () => {
      useConversationStore.setState({ isLoaded: false });
      render(<BackupModals />);
      await act(async () => {});
      expect(refreshRemoteStatus).not.toHaveBeenCalled();
    });

    it('is suppressed while the terms modal is open, and prompts after it closes', async () => {
      useUIStore.setState({ isTermsModalOpen: true });
      render(<BackupModals />);
      await act(async () => {});
      expect(refreshRemoteStatus).not.toHaveBeenCalled();
      expect(useUIStore.getState().backupModalView).toBeNull();

      act(() => {
        useUIStore.getState().setIsTermsModalOpen(false);
      });
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );
    });

    it('prompts at most once per mount (no re-nag after the user dismisses)', async () => {
      render(<BackupModals />);
      await waitFor(() =>
        expect(useUIStore.getState().backupModalView).toBe('enroll-intro'),
      );

      // Decline via the secondary button — persists declined + closes.
      act(() => {
        screen.getByText('intro.decline').click();
      });
      expect(useUIStore.getState().backupModalView).toBeNull();
      expect(useBackupStore.getState().enrollmentStatus).toBe('declined');

      // The effect re-runs on view/enrollment changes but must not re-prompt
      // or re-fetch.
      await act(async () => {});
      expect(refreshRemoteStatus).toHaveBeenCalledTimes(1);
      expect(useUIStore.getState().backupModalView).toBeNull();
    });

    it('does not prompt when the remote status is unknown (fetch failed)', async () => {
      refreshRemoteStatus.mockResolvedValue(null);
      render(<BackupModals />);
      await waitFor(() => expect(refreshRemoteStatus).toHaveBeenCalled());
      await act(async () => {});
      expect(useUIStore.getState().backupModalView).toBeNull();
    });
  });
});
