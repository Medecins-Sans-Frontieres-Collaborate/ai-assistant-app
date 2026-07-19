import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Backup-sync additions to conversationStore (persist v7): deletion
 * tombstones, folders last-modified stamp, and the v6 → v7 migration.
 */

const conv = (id: string): Conversation =>
  ({
    id,
    name: `Conv ${id}`,
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.7,
    folderId: null,
  }) as Conversation;

const folder = (id: string): FolderInterface => ({
  id,
  name: `Folder ${id}`,
  type: 'chat',
});

describe('conversationStore backup additions', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: false,
      deletedConversations: {},
      foldersUpdatedAt: null,
    });
  });

  describe('tombstone stamping', () => {
    it('deleteConversation stamps a tombstone with an ISO deletedAt', () => {
      useConversationStore.getState().setConversations([conv('a')]);

      const before = Date.now();
      useConversationStore.getState().deleteConversation('a');
      const after = Date.now();

      const tombstones = useConversationStore.getState().deletedConversations;
      expect(Object.keys(tombstones)).toEqual(['a']);
      const stamped = new Date(tombstones.a).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    it('deleting a non-existent conversation still records the tombstone', () => {
      useConversationStore.getState().deleteConversation('ghost');
      expect(
        useConversationStore.getState().deletedConversations.ghost,
      ).toBeDefined();
    });

    it('clearAll stamps tombstones for every conversation and clears folders', () => {
      useConversationStore.getState().setConversations([conv('a'), conv('b')]);
      useConversationStore.getState().setFolders([folder('f1')]);

      useConversationStore.getState().clearAll();

      const state = useConversationStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.folders).toEqual([]);
      expect(Object.keys(state.deletedConversations).sort()).toEqual([
        'a',
        'b',
      ]);
      // Folders wiped = local folder mutation → stamp moves.
      expect(state.foldersUpdatedAt).not.toBeNull();
    });

    it('caps tombstones at 500 by evicting the oldest', () => {
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const seeded: Record<string, string> = {};
      for (let i = 0; i < 500; i++) {
        seeded[`seed-${i}`] = new Date(base + i * 1000).toISOString();
      }
      useConversationStore.setState({
        conversations: [conv('newest')],
        deletedConversations: seeded,
      });

      useConversationStore.getState().deleteConversation('newest');

      const tombstones = useConversationStore.getState().deletedConversations;
      expect(Object.keys(tombstones)).toHaveLength(500);
      expect(tombstones['seed-0']).toBeUndefined(); // oldest evicted
      expect(tombstones['seed-1']).toBeDefined();
      expect(tombstones['newest']).toBeDefined();
    });

    it('re-stamping an existing tombstone does not evict anything', () => {
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const seeded: Record<string, string> = {};
      for (let i = 0; i < 500; i++) {
        seeded[`seed-${i}`] = new Date(base + i * 1000).toISOString();
      }
      useConversationStore.setState({ deletedConversations: seeded });

      useConversationStore.getState().deleteConversation('seed-250');

      const tombstones = useConversationStore.getState().deletedConversations;
      expect(Object.keys(tombstones)).toHaveLength(500);
      expect(tombstones['seed-0']).toBeDefined();
    });
  });

  describe('clearSyncedTombstones', () => {
    it('removes only the given ids', () => {
      useConversationStore.setState({
        deletedConversations: { a: 't1', b: 't2', c: 't3' },
      });

      useConversationStore.getState().clearSyncedTombstones(['a', 'c']);

      expect(useConversationStore.getState().deletedConversations).toEqual({
        b: 't2',
      });
    });

    it('is an identity no-op when nothing matches', () => {
      useConversationStore.setState({ deletedConversations: { a: 't1' } });
      const before = useConversationStore.getState().deletedConversations;

      useConversationStore.getState().clearSyncedTombstones(['zzz']);

      expect(useConversationStore.getState().deletedConversations).toBe(before);
    });
  });

  describe('foldersUpdatedAt stamping', () => {
    it('setFolders stamps "now" by default', () => {
      const before = Date.now();
      useConversationStore.getState().setFolders([folder('f1')]);
      const after = Date.now();

      const stamped = useConversationStore.getState().foldersUpdatedAt;
      expect(stamped).not.toBeNull();
      const at = new Date(stamped!).getTime();
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    });

    it('setFolders honours an explicit remote timestamp (backup pull path)', () => {
      const remoteAt = '2026-07-01T09:30:00.000Z';
      useConversationStore.getState().setFolders([folder('f1')], remoteAt);
      expect(useConversationStore.getState().foldersUpdatedAt).toBe(remoteAt);
    });

    it('addFolder / updateFolder / deleteFolder each move the stamp', () => {
      const readStamp = () => useConversationStore.getState().foldersUpdatedAt;

      useConversationStore.getState().addFolder(folder('f1'));
      const afterAdd = readStamp();
      expect(afterAdd).not.toBeNull();

      useConversationStore.setState({
        foldersUpdatedAt: '2000-01-01T00:00:00.000Z',
      });
      useConversationStore.getState().updateFolder('f1', 'Renamed');
      expect(readStamp()).not.toBe('2000-01-01T00:00:00.000Z');

      useConversationStore.setState({
        foldersUpdatedAt: '2000-01-01T00:00:00.000Z',
      });
      useConversationStore.getState().deleteFolder('f1');
      expect(readStamp()).not.toBe('2000-01-01T00:00:00.000Z');
    });
  });

  describe('persistence (v7)', () => {
    it('partialize includes tombstones and the folders stamp', () => {
      useConversationStore.setState({
        deletedConversations: { a: 't1' },
        foldersUpdatedAt: '2026-07-17T10:00:00.000Z',
      });

      const partialize = useConversationStore.persist.getOptions().partialize!;
      const persisted = partialize(useConversationStore.getState()) as Record<
        string,
        unknown
      >;

      expect(persisted.deletedConversations).toEqual({ a: 't1' });
      expect(persisted.foldersUpdatedAt).toBe('2026-07-17T10:00:00.000Z');
      // Runtime-only fields stay out of storage.
      expect(persisted).not.toHaveProperty('isLoaded');
      expect(persisted).not.toHaveProperty('searchTerm');
    });

    it('migrates v6 → v7 with empty tombstones and null folder stamp', () => {
      const migrate = useConversationStore.persist.getOptions().migrate!;
      const persisted = {
        conversations: [conv('a')],
        selectedConversationId: 'a',
        folders: [],
      };

      const result = migrate(persisted, 6) as Record<string, unknown>;

      expect(result.deletedConversations).toEqual({});
      expect(result.foldersUpdatedAt).toBeNull();
    });

    it('migrates v6 → v7 stamping foldersUpdatedAt when folders exist', () => {
      const migrate = useConversationStore.persist.getOptions().migrate!;
      const persisted = {
        conversations: [],
        selectedConversationId: null,
        folders: [folder('f1')],
      };

      const result = migrate(persisted, 6) as Record<string, unknown>;

      // Pre-existing folders must get backed up: null would leave the
      // folders blob pull-only forever.
      expect(typeof result.foldersUpdatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(result.foldersUpdatedAt as string))).toBe(
        false,
      );
    });

    it('keeps existing v7 fields intact when migrating from v7', () => {
      const migrate = useConversationStore.persist.getOptions().migrate!;
      const persisted = {
        conversations: [],
        selectedConversationId: null,
        folders: [],
        deletedConversations: { a: 't1' },
        foldersUpdatedAt: '2026-07-17T10:00:00.000Z',
      };

      const result = migrate(persisted, 7) as Record<string, unknown>;

      expect(result.deletedConversations).toEqual({ a: 't1' });
      expect(result.foldersUpdatedAt).toBe('2026-07-17T10:00:00.000Z');
    });

    it('corrupt-state guard includes the new fields', () => {
      const migrate = useConversationStore.persist.getOptions().migrate!;

      const result = migrate(null, 3) as Record<string, unknown>;

      expect(result.deletedConversations).toEqual({});
      expect(result.foldersUpdatedAt).toBeNull();
    });
  });
});
