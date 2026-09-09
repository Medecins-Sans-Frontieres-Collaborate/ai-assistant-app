import { createBackupApiClient } from '@/lib/services/backup/backupApiClient';
import { runSync } from '@/lib/services/backup/syncEngine';
import type { BackupApi } from '@/lib/services/backup/types';

import { switchBackupBackend } from '@/lib/utils/app/backup/backupOps';
import type { BackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import { useBackupStore } from '@/client/stores/backupStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/backup/backupApiClient', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/backup/backupApiClient')
    >();
  return {
    ...actual,
    createBackupApiClient: vi.fn(),
  };
});

vi.mock('@/lib/services/backup/syncEngine', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/backup/syncEngine')>();
  return {
    ...actual,
    runSync: vi.fn(),
    waitForSyncIdle: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/client/services/backup/syncCrypto', () => ({
  createSyncCrypto: vi.fn((keys: BackupKeys, epoch: number) => ({
    keyId: keys.keyId,
    epoch,
    encryptConversation: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
    decryptConversation: vi.fn(),
    encryptFolders: vi.fn().mockResolvedValue(new Uint8Array([3])),
    decryptFolders: vi.fn(),
  })),
}));

const KEYS = { keyId: 'a1b2c3d4e5f60718' } as unknown as BackupKeys;

function fakeApi(): BackupApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getManifest: vi.fn().mockResolvedValue(null),
    putManifest: vi.fn().mockResolvedValue({ etag: '"new"' }),
    putConversationBlob: vi.fn().mockResolvedValue(undefined),
    getConversationBlob: vi.fn(),
    deleteConversationBlob: vi.fn(),
    putFoldersBlob: vi.fn().mockResolvedValue(undefined),
    getFoldersBlob: vi.fn(),
    deleteBackup: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe('switchBackupBackend', () => {
  let appApi: ReturnType<typeof fakeApi>;
  let oneDriveApi: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    appApi = fakeApi();
    oneDriveApi = fakeApi();
    vi.mocked(createBackupApiClient).mockImplementation(
      (_fetch, backend = 'app') =>
        backend === 'onedrive' ? oneDriveApi : appApi,
    );
    vi.mocked(runSync).mockResolvedValue({
      status: 'ok',
      pushed: 0,
      pulled: 0,
      deleted: 0,
      conflictRetries: 0,
    });

    useBackupStore.setState({
      enrollmentStatus: 'enrolled',
      storageBackend: 'app',
      localKeyId: KEYS.keyId,
      localKeyEpoch: 3,
      lastSyncedVersion: 5,
      lastSyncedEtag: '"old"',
    });
    useConversationStore.setState({
      conversations: [
        { id: 'c1', updatedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'c2', updatedAt: '2026-08-02T00:00:00.000Z' },
      ] as never,
      folders: [],
      foldersUpdatedAt: null,
      deletedConversations: {},
    });
  });

  it('pulls from the source, pushes all to the target, flips, and tombstones the source', async () => {
    const result = await switchBackupBackend('onedrive', KEYS);

    // Pre-switch pull-merge ran against the SOURCE backend.
    expect(runSync).toHaveBeenCalledTimes(1);

    // Full corpus pushed to the target.
    expect(oneDriveApi.putConversationBlob).toHaveBeenCalledTimes(2);
    expect(oneDriveApi.putManifest).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: KEYS.keyId, version: 1 }),
      { ifMatchEtag: null },
    );

    // Device now points at OneDrive.
    expect(useBackupStore.getState().storageBackend).toBe('onedrive');

    // Old location wiped + disabled tombstone with the SOURCE epoch + 1.
    expect(appApi.deleteBackup).toHaveBeenCalled();
    expect(appApi.putManifest).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true, keyId: null, epoch: 4 }),
      { ifMatchEtag: null },
    );

    expect(result).toEqual({ pushed: 2, cleanupFailed: false });
  });

  it('no-ops when the target equals the current backend', async () => {
    const result = await switchBackupBackend('app', KEYS);
    expect(result).toEqual({ pushed: 0, cleanupFailed: false });
    expect(runSync).not.toHaveBeenCalled();
    expect(oneDriveApi.putManifest).not.toHaveBeenCalled();
  });

  it('aborts before pushing when the pre-switch sync fails', async () => {
    vi.mocked(runSync).mockResolvedValue({
      status: 'error',
      error: 'offline',
      pushed: 0,
      pulled: 0,
      deleted: 0,
      conflictRetries: 0,
    });

    await expect(switchBackupBackend('onedrive', KEYS)).rejects.toThrow(
      'offline',
    );
    expect(oneDriveApi.putConversationBlob).not.toHaveBeenCalled();
    expect(useBackupStore.getState().storageBackend).toBe('app');
    expect(appApi.deleteBackup).not.toHaveBeenCalled();
  });

  it('stays on the source backend when the target push fails', async () => {
    oneDriveApi.putManifest.mockRejectedValue(new Error('graph down'));

    await expect(switchBackupBackend('onedrive', KEYS)).rejects.toThrow(
      'graph down',
    );
    expect(useBackupStore.getState().storageBackend).toBe('app');
    expect(appApi.deleteBackup).not.toHaveBeenCalled();
  });

  it('reports cleanupFailed without failing the switch when old-location cleanup breaks', async () => {
    appApi.deleteBackup.mockRejectedValue(new Error('wipe failed'));

    const result = await switchBackupBackend('onedrive', KEYS);

    expect(useBackupStore.getState().storageBackend).toBe('onedrive');
    expect(result.cleanupFailed).toBe(true);
  });
});
