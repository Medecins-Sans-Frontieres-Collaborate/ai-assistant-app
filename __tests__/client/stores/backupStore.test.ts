import type { BackupManifest } from '@/lib/services/backup/types';

import { useBackupStore } from '@/client/stores/backupStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PERSISTED_DEFAULTS = {
  enrollmentStatus: 'unset' as const,
  storageBackend: 'app' as const,
  storageChosen: false,
  encryptionMode: 'encrypted' as const,
  localKeyId: null,
  localKeyEpoch: 1,
  lastSyncedVersion: null,
  lastSyncedEtag: null,
  lastBackupAt: null,
  lastSyncError: null,
};

const RUNTIME_DEFAULTS = {
  syncStatus: 'idle' as const,
  remoteExists: null,
  remoteKeyId: null,
  remoteKeyEpoch: null,
  flagEnabled: false,
  bannerCollapsed: false,
};

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    schemaVersion: 1,
    keyId: 'aabbccdd00112233',
    epoch: 1,
    version: 3,
    updatedAt: '2026-07-17T10:00:00.000Z',
    folders: null,
    conversations: {},
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('backupStore', () => {
  beforeEach(() => {
    useBackupStore.setState({ ...PERSISTED_DEFAULTS, ...RUNTIME_DEFAULTS });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct initial state', () => {
    const state = useBackupStore.getState();
    expect(state).toMatchObject({ ...PERSISTED_DEFAULTS, ...RUNTIME_DEFAULTS });
  });

  describe('enrollment transitions', () => {
    it('setEnrolled records status, keyId, and epoch', () => {
      useBackupStore.getState().setEnrolled('aabbccdd00112233', 2);

      const state = useBackupStore.getState();
      expect(state.enrollmentStatus).toBe('enrolled');
      expect(state.localKeyId).toBe('aabbccdd00112233');
      expect(state.localKeyEpoch).toBe(2);
    });

    it('setDeclined only flips the status', () => {
      useBackupStore.getState().setDeclined();
      expect(useBackupStore.getState().enrollmentStatus).toBe('declined');
      expect(useBackupStore.getState().localKeyId).toBeNull();
    });

    it('clearEnrollment resets enrollment and the sync point', () => {
      useBackupStore.getState().setEnrolled('aabbccdd00112233', 2);
      useBackupStore.getState().recordSyncPoint({
        version: 5,
        etag: 'W/"5"',
        epoch: 2,
        syncedAt: '2026-07-17T10:00:00.000Z',
      });

      useBackupStore.getState().clearEnrollment();

      expect(useBackupStore.getState()).toMatchObject({
        ...PERSISTED_DEFAULTS,
        syncStatus: 'idle',
      });
    });
  });

  describe('setSyncStatus', () => {
    it('stores the error message on error status', () => {
      useBackupStore.getState().setSyncStatus('error', 'boom');
      expect(useBackupStore.getState().syncStatus).toBe('error');
      expect(useBackupStore.getState().lastSyncError).toBe('boom');
    });

    it('falls back to a generic message when error status has no detail', () => {
      useBackupStore.getState().setSyncStatus('error');
      expect(useBackupStore.getState().lastSyncError).toBe(
        'Backup sync failed',
      );
    });

    it('clears the error on ok, preserves it on intermediate statuses', () => {
      useBackupStore.getState().setSyncStatus('error', 'boom');

      useBackupStore.getState().setSyncStatus('syncing');
      expect(useBackupStore.getState().lastSyncError).toBe('boom');

      useBackupStore.getState().setSyncStatus('ok');
      expect(useBackupStore.getState().lastSyncError).toBeNull();
    });
  });

  describe('recordSyncPoint', () => {
    it('persists version/etag, adopts the manifest epoch, stamps lastBackupAt', () => {
      useBackupStore.getState().setSyncStatus('error', 'old failure');

      useBackupStore.getState().recordSyncPoint({
        version: 7,
        etag: 'W/"7"',
        epoch: 3,
        syncedAt: '2026-07-17T12:34:56.000Z',
      });

      const state = useBackupStore.getState();
      expect(state.lastSyncedVersion).toBe(7);
      expect(state.lastSyncedEtag).toBe('W/"7"');
      expect(state.localKeyEpoch).toBe(3);
      expect(state.lastBackupAt).toBe('2026-07-17T12:34:56.000Z');
      expect(state.lastSyncError).toBeNull();
    });
  });

  describe('refreshRemoteStatus', () => {
    it('caches existence/keyId/epoch for a live manifest', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            data: { manifest: manifest({ epoch: 4 }), etag: 'W/"3"' },
          }),
        ),
      );

      const result = await useBackupStore.getState().refreshRemoteStatus();

      expect(result).toEqual({
        exists: true,
        keyId: 'aabbccdd00112233',
        epoch: 4,
        disabled: false,
      });
      const state = useBackupStore.getState();
      expect(state.remoteExists).toBe(true);
      expect(state.remoteKeyId).toBe('aabbccdd00112233');
      expect(state.remoteKeyEpoch).toBe(4);
    });

    it('reports absence on 404', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(404, { error: 'not found', code: 'BACKUP_NOT_FOUND' }),
        ),
      );

      const result = await useBackupStore.getState().refreshRemoteStatus();

      expect(result).toEqual({
        exists: false,
        keyId: null,
        epoch: null,
        disabled: false,
      });
      expect(useBackupStore.getState().remoteExists).toBe(false);
    });

    it('treats a disabled tombstone manifest as non-existent but disabled', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            data: {
              manifest: manifest({ disabled: true, keyId: null, epoch: 5 }),
              etag: 'W/"9"',
            },
          }),
        ),
      );

      const result = await useBackupStore.getState().refreshRemoteStatus();

      expect(result).toEqual({
        exists: false,
        keyId: null,
        epoch: 5,
        disabled: true,
      });
      expect(useBackupStore.getState().remoteExists).toBe(false);
      expect(useBackupStore.getState().remoteKeyEpoch).toBe(5);
    });

    it('returns null and leaves state untouched on network failure', async () => {
      useBackupStore.setState({ remoteExists: true, remoteKeyId: 'cached' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('offline');
        }),
      );

      const result = await useBackupStore.getState().refreshRemoteStatus();

      expect(result).toBeNull();
      expect(useBackupStore.getState().remoteExists).toBe(true);
      expect(useBackupStore.getState().remoteKeyId).toBe('cached');
    });
  });

  describe('persistence', () => {
    it('partialize persists exactly the device-scoped fields (no runtime state)', () => {
      const partialize = useBackupStore.persist.getOptions().partialize!;
      const persisted = partialize(useBackupStore.getState()) as Record<
        string,
        unknown
      >;

      expect(Object.keys(persisted).sort()).toEqual(
        Object.keys(PERSISTED_DEFAULTS).sort(),
      );
      for (const runtimeKey of Object.keys(RUNTIME_DEFAULTS)) {
        expect(persisted).not.toHaveProperty(runtimeKey);
      }
    });

    it('migrate guards against corrupted storage', () => {
      const migrate = useBackupStore.persist.getOptions().migrate!;

      const result = migrate(null, 0) as Record<string, unknown>;
      expect(result).toEqual(PERSISTED_DEFAULTS);
    });

    it('migrate defaults v1 blobs (no storageBackend) to app storage', () => {
      const migrate = useBackupStore.persist.getOptions().migrate!;
      const v1 = { ...PERSISTED_DEFAULTS } as Record<string, unknown>;
      delete v1.storageBackend;

      const result = migrate(v1, 1) as Record<string, unknown>;
      expect(result.storageBackend).toBe('app');
    });

    it('migrate passes a valid v1 blob through unchanged', () => {
      const migrate = useBackupStore.persist.getOptions().migrate!;
      const persisted = {
        ...PERSISTED_DEFAULTS,
        enrollmentStatus: 'enrolled',
        localKeyId: 'aabbccdd00112233',
        lastSyncedVersion: 12,
      };

      expect(migrate(persisted, 1)).toEqual(persisted);
    });

    it('flag mirror and banner state are runtime-only setters', () => {
      useBackupStore.getState().setFlagEnabled(true);
      useBackupStore.getState().setBannerCollapsed(true);

      expect(useBackupStore.getState().flagEnabled).toBe(true);
      expect(useBackupStore.getState().bannerCollapsed).toBe(true);

      const partialize = useBackupStore.persist.getOptions().partialize!;
      const persisted = partialize(useBackupStore.getState()) as Record<
        string,
        unknown
      >;
      expect(persisted.flagEnabled).toBeUndefined();
      expect(persisted.bannerCollapsed).toBeUndefined();
    });
  });
});
