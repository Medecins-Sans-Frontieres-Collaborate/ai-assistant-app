import { BackupApiError } from '@/lib/services/backup/backupApiClient';
import {
  resetSyncEngineForTests,
  restoreFromRemote,
  runSync,
} from '@/lib/services/backup/syncEngine';
import type {
  BackupManifest,
  BackupManifestEntry,
  LocalBackupState,
  ManifestFetchResult,
  SyncDeps,
  SyncPoint,
} from '@/lib/services/backup/types';

import type { Conversation } from '@/types/chat';

import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_ID = 'a1b2c3d4e5f60718';
const T1 = '2026-07-01T10:00:00.000Z';
const T2 = '2026-07-02T10:00:00.000Z';
const T3 = '2026-07-03T10:00:00.000Z';

const enc = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b));

function conv(id: string, updatedAt?: string): Conversation {
  return { id, updatedAt } as Conversation;
}

function manifest(
  conversations: Record<string, BackupManifestEntry> = {},
  partial: Partial<BackupManifest> = {},
): BackupManifest {
  return {
    schemaVersion: 1,
    keyId: KEY_ID,
    epoch: 1,
    version: 5,
    updatedAt: T2,
    folders: null,
    conversations,
    ...partial,
  };
}

function live(rev: string, updatedAt: string): BackupManifestEntry {
  return { rev, updatedAt, size: 100 };
}

interface Harness {
  deps: SyncDeps;
  calls: string[];
  api: {
    getManifest: Mock;
    putManifest: Mock;
    putConversationBlob: Mock;
    getConversationBlob: Mock;
    deleteConversationBlob: Mock;
    putFoldersBlob: Mock;
    getFoldersBlob: Mock;
    deleteBackup: Mock;
  };
  applyRemote: Mock;
  clearTombstones: Mock;
  persistSyncPoint: Mock;
  onStatus: Mock;
}

function makeHarness(opts: {
  remote?: ManifestFetchResult | null;
  local?: Partial<LocalBackupState>;
  syncPoint?: SyncPoint;
}): Harness {
  const calls: string[] = [];
  const api: Harness['api'] = {
    getManifest: vi.fn(async () => {
      calls.push('getManifest');
      return opts.remote ?? null;
    }),
    putManifest: vi.fn(async () => {
      calls.push('putManifest');
      return { etag: '"next"' };
    }),
    putConversationBlob: vi.fn(async (id: string) => {
      calls.push(`putBlob:${id}`);
    }),
    getConversationBlob: vi.fn(async (id: string) => {
      calls.push(`getBlob:${id}`);
      return enc(conv(id, T2));
    }),
    deleteConversationBlob: vi.fn(),
    putFoldersBlob: vi.fn(async () => {
      calls.push('putFolders');
    }),
    getFoldersBlob: vi.fn(async () => {
      calls.push('getFolders');
      return enc([]);
    }),
    deleteBackup: vi.fn(),
  };
  const applyRemote = vi.fn(async () => {
    calls.push('applyRemote');
  });
  const clearTombstones = vi.fn(() => {
    calls.push('clearTombstones');
  });
  const persistSyncPoint = vi.fn(() => {
    calls.push('persistSyncPoint');
  });
  const onStatus = vi.fn();

  const local: LocalBackupState = {
    conversations: [],
    folders: [],
    foldersUpdatedAt: null,
    tombstones: {},
    ...opts.local,
  };

  const deps: SyncDeps = {
    api,
    crypto: {
      keyId: KEY_ID,
      epoch: 1,
      encryptConversation: async (c) => enc(c),
      decryptConversation: async (_id, _epoch, bytes) =>
        dec(bytes) as Conversation,
      encryptFolders: async (f) => enc(f),
      decryptFolders: async (_epoch, bytes) => dec(bytes) as never,
    },
    getLocalState: () => local,
    getSyncPoint: () =>
      opts.syncPoint ?? { lastSyncedVersion: null, lastSyncedEtag: null },
    applyRemote,
    clearTombstones,
    persistSyncPoint,
    onStatus,
  };

  return {
    deps,
    calls,
    api,
    applyRemote,
    clearTombstones,
    persistSyncPoint,
    onStatus,
  };
}

const conflictError = () =>
  new BackupApiError('conflict', 'BACKUP_VERSION_CONFLICT', 409);

beforeEach(() => {
  resetSyncEngineForTests();
  vi.clearAllMocks();
});

describe('runSync — state detection', () => {
  it('404 with no prior sync → first push: epoch 1, version 1, no If-Match', async () => {
    const h = makeHarness({
      remote: null,
      local: {
        conversations: [conv('c1', T1)],
        foldersUpdatedAt: T1,
        tombstones: { old: T1 },
      },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('ok');
    expect(res.pushed).toBe(1);
    const [next, putOpts] = h.api.putManifest.mock.calls[0];
    expect(putOpts).toEqual({ ifMatchEtag: null });
    expect(next.version).toBe(1);
    expect(next.epoch).toBe(1);
    expect(next.keyId).toBe(KEY_ID);
    expect(next.conversations.c1).toMatchObject({ updatedAt: T1 });
    // tombstones for a never-existing backup are not published
    expect(next.conversations.old).toBeUndefined();
    expect(h.persistSyncPoint).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, etag: '"next"', epoch: 1 }),
    );
  });

  it('404 after having synced → remote-missing, zero writes', async () => {
    const h = makeHarness({
      remote: null,
      local: { conversations: [conv('c1', T1)] },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e"' },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('remote-missing');
    expect(h.api.putConversationBlob).not.toHaveBeenCalled();
    expect(h.api.putManifest).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith('remote-missing');
  });

  it('remote keyId mismatch → key-out-of-date with zero writes after detection', async () => {
    const h = makeHarness({
      remote: {
        manifest: manifest({}, { keyId: 'ffffffffffffffff', epoch: 2 }),
        etag: '"e"',
      },
      local: { conversations: [conv('c1', T3)] },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('key-out-of-date');
    expect(h.api.putConversationBlob).not.toHaveBeenCalled();
    expect(h.api.putManifest).not.toHaveBeenCalled();
    expect(h.api.getConversationBlob).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.persistSyncPoint).not.toHaveBeenCalled();
  });

  it('disabled tombstone manifest → remote-missing', async () => {
    const h = makeHarness({
      remote: {
        manifest: manifest({}, { keyId: null, epoch: 2, disabled: true }),
        etag: '"e"',
      },
    });

    const res = await runSync(h.deps);
    expect(res.status).toBe('remote-missing');
    expect(h.api.putManifest).not.toHaveBeenCalled();
  });
});

describe('runSync — push path', () => {
  it('uploads all blobs before the manifest CAS', async () => {
    const h = makeHarness({
      remote: { manifest: manifest({ c1: live('r1', T1) }), etag: '"e1"' },
      local: {
        conversations: [conv('c1', T3), conv('c2', T2)],
        foldersUpdatedAt: T2,
      },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('ok');
    const casIndex = h.calls.indexOf('putManifest');
    expect(casIndex).toBeGreaterThan(-1);
    for (const blobCall of ['putBlob:c1', 'putBlob:c2', 'putFolders']) {
      expect(h.calls.indexOf(blobCall)).toBeGreaterThan(-1);
      expect(h.calls.indexOf(blobCall)).toBeLessThan(casIndex);
    }
  });

  it('409 → refetch, merge, re-push with the new etag; succeeds on retry', async () => {
    const h = makeHarness({
      local: { conversations: [conv('c1', T3)] },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });
    h.api.getManifest
      .mockImplementationOnce(async () => {
        h.calls.push('getManifest');
        return { manifest: manifest({ c1: live('r1', T1) }), etag: '"e1"' };
      })
      .mockImplementationOnce(async () => {
        h.calls.push('getManifest');
        return {
          manifest: manifest(
            { c1: live('r1', T1), c2: live('r2', T2) },
            { version: 6 },
          ),
          etag: '"e2"',
        };
      });
    h.api.putManifest
      .mockImplementationOnce(async () => {
        h.calls.push('putManifest');
        throw conflictError();
      })
      .mockImplementationOnce(async () => {
        h.calls.push('putManifest');
        return { etag: '"e3"' };
      });

    const res = await runSync(h.deps);

    expect(res.status).toBe('ok');
    expect(res.conflictRetries).toBe(1);
    expect(res.pushed).toBe(1);
    expect(res.pulled).toBe(1); // c2 arrived remotely during the conflict
    expect(h.api.getManifest).toHaveBeenCalledTimes(2);
    const [next, putOpts] = h.api.putManifest.mock.calls[1];
    expect(next.version).toBe(7);
    expect(putOpts).toEqual({ ifMatchEtag: '"e2"' });
    expect(h.applyRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [expect.objectContaining({ id: 'c2' })],
      }),
    );
  });

  it('three consecutive 409s → error, tombstones never cleared', async () => {
    const h = makeHarness({
      remote: { manifest: manifest({ c1: live('r1', T1) }), etag: '"e1"' },
      local: { conversations: [conv('c1', T3)], tombstones: { gone: T2 } },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });
    h.api.putManifest.mockImplementation(async () => {
      h.calls.push('putManifest');
      throw conflictError();
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('error');
    expect(res.errorCode).toBe('BACKUP_VERSION_CONFLICT');
    expect(res.conflictRetries).toBe(3);
    expect(h.api.putManifest).toHaveBeenCalledTimes(3);
    expect(h.clearTombstones).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.persistSyncPoint).not.toHaveBeenCalled();
  });

  it('BACKUP_KEY_MISMATCH from the CAS → key-out-of-date, no retry, no further writes', async () => {
    const h = makeHarness({
      remote: { manifest: manifest(), etag: '"e1"' },
      local: { conversations: [conv('c1', T3)] },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });
    h.api.putManifest.mockImplementation(async () => {
      h.calls.push('putManifest');
      throw new BackupApiError('rotated', 'BACKUP_KEY_MISMATCH', 409);
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('key-out-of-date');
    expect(h.api.putManifest).toHaveBeenCalledTimes(1);
    expect(h.api.getManifest).toHaveBeenCalledTimes(1); // no refetch loop
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.clearTombstones).not.toHaveBeenCalled();
    expect(h.persistSyncPoint).not.toHaveBeenCalled();
  });

  it('clears tombstones only after a successful CAS', async () => {
    const h = makeHarness({
      remote: { manifest: manifest({ gone: live('r1', T1) }), etag: '"e1"' },
      local: { tombstones: { gone: T2 } },
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('ok');
    expect(h.clearTombstones).toHaveBeenCalledWith(['gone']);
    expect(h.calls.indexOf('clearTombstones')).toBeGreaterThan(
      h.calls.indexOf('putManifest'),
    );
    const [next] = h.api.putManifest.mock.calls[0];
    expect(next.conversations.gone).toMatchObject({
      deleted: true,
      deletedAt: T2,
    });
  });

  it('pull-only sync applies remote data without touching the manifest', async () => {
    const h = makeHarness({
      remote: {
        manifest: manifest({ c1: live('r1', T2) }, { version: 6 }),
        etag: '"e2"',
      },
      local: {},
      syncPoint: { lastSyncedVersion: 5, lastSyncedEtag: '"e1"' },
    });

    const res = await runSync(h.deps);

    expect(res.status).toBe('ok');
    expect(res.pulled).toBe(1);
    expect(h.api.putManifest).not.toHaveBeenCalled();
    expect(h.applyRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [expect.objectContaining({ id: 'c1' })],
      }),
    );
    expect(h.persistSyncPoint).toHaveBeenCalledWith(
      expect.objectContaining({ version: 6, etag: '"e2"' }),
    );
  });
});

describe('runSync — single-flight', () => {
  it('overlapping calls share the in-flight promise and queue one rerun', async () => {
    const h = makeHarness({
      remote: null,
      local: { conversations: [conv('c1', T1)] },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.api.getManifest.mockImplementation(async () => {
      h.calls.push('getManifest');
      await gate;
      return null;
    });

    const p1 = runSync(h.deps);
    const p2 = runSync(h.deps);
    const p3 = runSync(h.deps);
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(h.api.getManifest).toHaveBeenCalledTimes(1);

    release();
    const res = await p1;

    expect(res.status).toBe('ok');
    // exactly one queued rerun executed after the first pass settled
    expect(h.api.getManifest).toHaveBeenCalledTimes(2);

    // a fresh call after completion starts a new run
    await runSync(h.deps);
    expect(h.api.getManifest).toHaveBeenCalledTimes(3);
  });
});

describe('restoreFromRemote', () => {
  it('downloads and decrypts all live conversations, skipping tombstones', async () => {
    const h = makeHarness({
      remote: {
        manifest: manifest(
          {
            c1: live('r1', T1),
            c2: live('r2', T2),
            dead: {
              rev: '',
              updatedAt: T1,
              size: 0,
              deleted: true,
              deletedAt: T1,
            },
          },
          { folders: { rev: 'fr', updatedAt: T1 } },
        ),
        etag: '"e1"',
      },
    });

    const res = await restoreFromRemote(h.deps);

    expect(res.status).toBe('ok');
    expect(res.pulled).toBe(2);
    expect(h.api.getConversationBlob).toHaveBeenCalledTimes(2);
    expect(h.api.getFoldersBlob).toHaveBeenCalledWith('fr');
    expect(h.applyRemote).toHaveBeenCalledWith(
      expect.objectContaining({ deleteIds: [], folders: [] }),
    );
    expect(h.persistSyncPoint).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5, etag: '"e1"', epoch: 1 }),
    );
  });

  it('missing manifest → remote-missing; wrong key → key-out-of-date', async () => {
    const missing = makeHarness({ remote: null });
    await expect(restoreFromRemote(missing.deps)).resolves.toMatchObject({
      status: 'remote-missing',
    });

    const wrongKey = makeHarness({
      remote: {
        manifest: manifest({}, { keyId: 'ffffffffffffffff' }),
        etag: '"e"',
      },
    });
    const res = await restoreFromRemote(wrongKey.deps);
    expect(res.status).toBe('key-out-of-date');
    expect(wrongKey.api.getConversationBlob).not.toHaveBeenCalled();
    expect(wrongKey.applyRemote).not.toHaveBeenCalled();
  });
});
