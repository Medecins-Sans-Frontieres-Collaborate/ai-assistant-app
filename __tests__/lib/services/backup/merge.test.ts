import {
  buildNextManifest,
  computeLocalChanges,
  conversationUpdatedAt,
  mergeManifest,
} from '@/lib/services/backup/merge';
import type {
  BackupManifest,
  BackupManifestEntry,
  LocalBackupState,
  MergePlan,
} from '@/lib/services/backup/types';

import type { Conversation } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const T1 = '2026-07-01T10:00:00.000Z';
const T2 = '2026-07-02T10:00:00.000Z';
const T3 = '2026-07-03T10:00:00.000Z';

function conv(id: string, updatedAt?: string): Conversation {
  return { id, updatedAt } as Conversation;
}

function localState(partial: Partial<LocalBackupState> = {}): LocalBackupState {
  return {
    conversations: [],
    folders: [],
    foldersUpdatedAt: null,
    tombstones: {},
    ...partial,
  };
}

function manifest(
  conversations: Record<string, BackupManifestEntry> = {},
  partial: Partial<BackupManifest> = {},
): BackupManifest {
  return {
    schemaVersion: 1,
    keyId: 'a1b2c3d4e5f60718',
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

function tombstone(deletedAt: string): BackupManifestEntry {
  return { rev: '', updatedAt: deletedAt, size: 0, deleted: true, deletedAt };
}

describe('mergeManifest — LWW matrix', () => {
  it('local newer than remote → push', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T2)] }),
      manifest({ c1: live('r1', T1) }),
    );
    expect(plan.pushIds).toEqual(['c1']);
    expect(plan.pullIds).toEqual([]);
  });

  it('remote newer than local → pull', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T1)] }),
      manifest({ c1: live('r1', T2) }),
    );
    expect(plan.pullIds).toEqual(['c1']);
    expect(plan.pushIds).toEqual([]);
  });

  it('tie → remote wins (pull)', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T2)] }),
      manifest({ c1: live('r1', T2) }),
    );
    expect(plan.pullIds).toEqual(['c1']);
    expect(plan.pushIds).toEqual([]);
  });

  it('local-only conversation → push', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T1)] }),
      manifest({}),
    );
    expect(plan.pushIds).toEqual(['c1']);
  });

  it('remote-only conversation → pull', () => {
    const plan = mergeManifest(localState(), manifest({ c1: live('r1', T1) }));
    expect(plan.pullIds).toEqual(['c1']);
  });

  it('remote tombstone newer than local edit → delete locally', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T1)] }),
      manifest({ c1: tombstone(T2) }),
    );
    expect(plan.applyDeletes).toEqual(['c1']);
    expect(plan.pushIds).toEqual([]);
    expect(plan.resurrectIds).toEqual([]);
  });

  it('remote tombstone tied with local edit → delete wins', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T2)] }),
      manifest({ c1: tombstone(T2) }),
    );
    expect(plan.applyDeletes).toEqual(['c1']);
  });

  it('local edit newer than remote tombstone → resurrection lands in pushIds', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T3)] }),
      manifest({ c1: tombstone(T2) }),
    );
    expect(plan.resurrectIds).toEqual(['c1']);
    expect(plan.pushIds).toEqual(['c1']);
    expect(plan.applyDeletes).toEqual([]);
  });

  it('local tombstone newer than remote live → push tombstone', () => {
    const plan = mergeManifest(
      localState({ tombstones: { c1: T2 } }),
      manifest({ c1: live('r1', T1) }),
    );
    expect(plan.pushTombstoneIds).toEqual(['c1']);
    expect(plan.pullIds).toEqual([]);
  });

  it('local tombstone tied with remote live → delete wins', () => {
    const plan = mergeManifest(
      localState({ tombstones: { c1: T2 } }),
      manifest({ c1: live('r1', T2) }),
    );
    expect(plan.pushTombstoneIds).toEqual(['c1']);
  });

  it('remote edit newer than local tombstone → pull (remote resurrects)', () => {
    const plan = mergeManifest(
      localState({ tombstones: { c1: T1 } }),
      manifest({ c1: live('r1', T2) }),
    );
    expect(plan.pullIds).toEqual(['c1']);
    expect(plan.pushTombstoneIds).toEqual([]);
  });

  it('tombstones on both sides → no action', () => {
    const plan = mergeManifest(
      localState({ tombstones: { c1: T2 } }),
      manifest({ c1: tombstone(T1) }),
    );
    expect(plan).toEqual<MergePlan>({
      pullIds: [],
      pushIds: [],
      applyDeletes: [],
      resurrectIds: [],
      pushTombstoneIds: [],
      foldersAction: 'none',
    });
  });

  it('local tombstone unknown to remote → published as tombstone', () => {
    const plan = mergeManifest(
      localState({ tombstones: { c1: T1 } }),
      manifest({}),
    );
    expect(plan.pushTombstoneIds).toEqual(['c1']);
  });

  it('live local copy overrides a stale local tombstone for the same id', () => {
    const plan = mergeManifest(
      localState({ conversations: [conv('c1', T3)], tombstones: { c1: T1 } }),
      manifest({ c1: live('r1', T2) }),
    );
    expect(plan.pushIds).toEqual(['c1']);
    expect(plan.pushTombstoneIds).toEqual([]);
  });

  it('missing local updatedAt falls back to createdAt, else loses LWW', () => {
    const noTimestamps = { id: 'c1' } as Conversation;
    const plan = mergeManifest(
      localState({ conversations: [noTimestamps] }),
      manifest({ c1: live('r1', T1) }),
    );
    expect(plan.pullIds).toEqual(['c1']);
  });
});

describe('mergeManifest — folders whole-LWW', () => {
  it('neither side has folders → none', () => {
    expect(mergeManifest(localState(), manifest()).foldersAction).toBe('none');
  });

  it('local only → push', () => {
    const plan = mergeManifest(
      localState({ foldersUpdatedAt: T1 }),
      manifest(),
    );
    expect(plan.foldersAction).toBe('push');
  });

  it('remote only → pull', () => {
    const plan = mergeManifest(
      localState(),
      manifest({}, { folders: { rev: 'fr', updatedAt: T1 } }),
    );
    expect(plan.foldersAction).toBe('pull');
  });

  it('local newer → push; remote newer → pull; tie → none', () => {
    const remoteFolders = { folders: { rev: 'fr', updatedAt: T2 } };
    expect(
      mergeManifest(
        localState({ foldersUpdatedAt: T3 }),
        manifest({}, remoteFolders),
      ).foldersAction,
    ).toBe('push');
    expect(
      mergeManifest(
        localState({ foldersUpdatedAt: T1 }),
        manifest({}, remoteFolders),
      ).foldersAction,
    ).toBe('pull');
    expect(
      mergeManifest(
        localState({ foldersUpdatedAt: T2 }),
        manifest({}, remoteFolders),
      ).foldersAction,
    ).toBe('none');
  });
});

describe('computeLocalChanges', () => {
  it('no remote manifest → push everything, skip tombstones', () => {
    const plan = computeLocalChanges(
      localState({
        conversations: [conv('c1', T1), conv('c2', T2)],
        foldersUpdatedAt: T1,
        tombstones: { gone: T1 },
      }),
      null,
    );
    expect(plan.pushIds.sort()).toEqual(['c1', 'c2']);
    expect(plan.pushTombstoneIds).toEqual([]);
    expect(plan.pullIds).toEqual([]);
    expect(plan.foldersAction).toBe('push');
  });

  it('unchanged entries are skipped; changed or new ones pushed', () => {
    const plan = computeLocalChanges(
      localState({
        conversations: [conv('same', T1), conv('edited', T3), conv('new', T2)],
      }),
      manifest({ same: live('r1', T1), edited: live('r2', T2) }),
    );
    expect(plan.pushIds.sort()).toEqual(['edited', 'new']);
    expect(plan.pullIds).toEqual([]);
  });

  it('locally re-created conversation over own tombstone entry → push + resurrect', () => {
    const plan = computeLocalChanges(
      localState({ conversations: [conv('c1', T3)] }),
      manifest({ c1: tombstone(T2) }),
    );
    expect(plan.pushIds).toEqual(['c1']);
    expect(plan.resurrectIds).toEqual(['c1']);
  });

  it('local tombstone for a remote live entry → push tombstone; unknown ids skipped', () => {
    const plan = computeLocalChanges(
      localState({ tombstones: { c1: T2, unknown: T2 } }),
      manifest({ c1: live('r1', T1) }),
    );
    expect(plan.pushTombstoneIds).toEqual(['c1']);
  });

  it('folders push only when timestamp differs from manifest', () => {
    const withFolders = { folders: { rev: 'fr', updatedAt: T1 } };
    expect(
      computeLocalChanges(
        localState({ foldersUpdatedAt: T1 }),
        manifest({}, withFolders),
      ).foldersAction,
    ).toBe('none');
    expect(
      computeLocalChanges(
        localState({ foldersUpdatedAt: T2 }),
        manifest({}, withFolders),
      ).foldersAction,
    ).toBe('push');
  });
});

describe('buildNextManifest', () => {
  const keyId = 'a1b2c3d4e5f60718';

  it('increments version by exactly 1 (and starts at 1 with no base)', () => {
    const plan: MergePlan = {
      pullIds: [],
      pushIds: [],
      applyDeletes: [],
      resurrectIds: [],
      pushTombstoneIds: [],
      foldersAction: 'none',
    };
    const fresh = buildNextManifest({
      base: null,
      plan,
      uploads: {},
      foldersUpload: null,
      tombstones: {},
      keyId,
      epoch: 1,
      now: T3,
    });
    expect(fresh.version).toBe(1);
    expect(fresh.epoch).toBe(1);
    expect(fresh.keyId).toBe(keyId);

    const next = buildNextManifest({
      base: manifest({}, { version: 7 }),
      plan,
      uploads: {},
      foldersUpload: null,
      tombstones: {},
      keyId,
      epoch: 1,
      now: T3,
    });
    expect(next.version).toBe(8);
  });

  it('swaps in pushed blobs, records tombstones, carries untouched entries', () => {
    const base = manifest({
      kept: live('rk', T1),
      pushed: live('rold', T1),
      killed: live('rkill', T1),
    });
    const next = buildNextManifest({
      base,
      plan: {
        pullIds: [],
        pushIds: ['pushed'],
        applyDeletes: [],
        resurrectIds: [],
        pushTombstoneIds: ['killed'],
        foldersAction: 'none',
      },
      uploads: { pushed: { rev: 'rnew', size: 42, updatedAt: T2 } },
      foldersUpload: null,
      tombstones: { killed: T2 },
      keyId,
      epoch: 1,
      now: T3,
    });
    expect(next.conversations.kept).toEqual(live('rk', T1));
    expect(next.conversations.pushed).toEqual({
      rev: 'rnew',
      updatedAt: T2,
      size: 42,
    });
    expect(next.conversations.killed).toEqual({
      rev: 'rkill',
      updatedAt: T2,
      size: 0,
      deleted: true,
      deletedAt: T2,
    });
    expect(next.updatedAt).toBe(T3);
  });

  it('folders: push replaces, otherwise the base value is carried', () => {
    const base = manifest({}, { folders: { rev: 'fold', updatedAt: T1 } });
    const pushed = buildNextManifest({
      base,
      plan: {
        pullIds: [],
        pushIds: [],
        applyDeletes: [],
        resurrectIds: [],
        pushTombstoneIds: [],
        foldersAction: 'push',
      },
      uploads: {},
      foldersUpload: { rev: 'fnew', updatedAt: T2 },
      tombstones: {},
      keyId,
      epoch: 1,
      now: T3,
    });
    expect(pushed.folders).toEqual({ rev: 'fnew', updatedAt: T2 });

    const carried = buildNextManifest({
      base,
      plan: {
        pullIds: [],
        pushIds: [],
        applyDeletes: [],
        resurrectIds: [],
        pushTombstoneIds: [],
        foldersAction: 'pull',
      },
      uploads: {},
      foldersUpload: null,
      tombstones: {},
      keyId,
      epoch: 1,
      now: T3,
    });
    expect(carried.folders).toEqual({ rev: 'fold', updatedAt: T1 });
  });

  it('throws when a pushed id has no uploaded blob', () => {
    expect(() =>
      buildNextManifest({
        base: null,
        plan: {
          pullIds: [],
          pushIds: ['c1'],
          applyDeletes: [],
          resurrectIds: [],
          pushTombstoneIds: [],
          foldersAction: 'none',
        },
        uploads: {},
        foldersUpload: null,
        tombstones: {},
        keyId,
        epoch: 1,
        now: T3,
      }),
    ).toThrow(/missing upload/);
  });
});

describe('conversationUpdatedAt', () => {
  it('prefers updatedAt, then createdAt', () => {
    expect(
      conversationUpdatedAt({
        id: 'a',
        updatedAt: T2,
        createdAt: T1,
      } as Conversation),
    ).toBe(T2);
    expect(
      conversationUpdatedAt({ id: 'a', createdAt: T1 } as Conversation),
    ).toBe(T1);
  });

  it('falls back to a VALID epoch timestamp for legacy conversations', () => {
    // An empty string here fails the server's manifest validation and one
    // legacy conversation would 400 every backup write for the whole corpus.
    const value = conversationUpdatedAt({ id: 'legacy' } as Conversation);
    expect(value).toBe('1970-01-01T00:00:00.000Z');
    // Empty-string fields (not just absent ones) get the same fallback.
    expect(
      conversationUpdatedAt({
        id: 'a',
        updatedAt: '',
        createdAt: '',
      } as Conversation),
    ).toBe('1970-01-01T00:00:00.000Z');
  });
});
