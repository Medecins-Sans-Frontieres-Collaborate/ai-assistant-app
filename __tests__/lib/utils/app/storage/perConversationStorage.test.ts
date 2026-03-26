import {
  clearAllConversationStorage,
  getPerConversationStorageKeys,
  perConversationStorage,
} from '@/lib/utils/app/storage/perConversationStorage';
import { getQuarantinedItems } from '@/lib/utils/app/storage/quarantineStore';

import { afterEach, describe, expect, it, vi } from 'vitest';

function makeConversation(id: string, name = 'Test') {
  return {
    id,
    name,
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4' },
    temperature: 0.7,
    prompt: '',
    folderId: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function makeFolder(id: string, name = 'Folder') {
  return { id, name, type: 'chat' };
}

describe('perConversationStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('getItem', () => {
    it('returns null when no data exists', () => {
      const result = perConversationStorage.getItem('conversation-storage');
      expect(result).toBeNull();
    });

    it('loads conversations from per-conversation keys', () => {
      const conv = makeConversation('c1', 'First');
      localStorage.setItem('conv-data-c1', JSON.stringify(conv));
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['c1'],
          selectedConversationId: 'c1',
          folderIds: [],
        }),
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('c1');
      expect(parsed.state.selectedConversationId).toBe('c1');
    });

    it('migrates from legacy blob', () => {
      const legacyBlob = {
        state: {
          conversations: [makeConversation('legacy-1')],
          selectedConversationId: 'legacy-1',
          folders: [makeFolder('f1')],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('legacy-1');

      // Legacy blob should be removed
      expect(localStorage.getItem('conversation-storage')).toBeNull();

      // Per-conversation keys should exist
      expect(localStorage.getItem('conv-data-legacy-1')).not.toBeNull();
      expect(localStorage.getItem('conv-index')).not.toBeNull();
    });

    it('quarantines corrupted conversations during load', () => {
      localStorage.setItem(
        'conv-data-good',
        JSON.stringify(makeConversation('good')),
      );
      localStorage.setItem('conv-data-bad', '{not valid json');
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['good', 'bad'],
          selectedConversationId: null,
          folderIds: [],
        }),
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      // Good conversation loaded
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('good');

      // Bad conversation quarantined
      const quarantined = getQuarantinedItems();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].rawData).toBe('{not valid json');

      // Index updated to remove bad conversation
      const updatedIndex = JSON.parse(localStorage.getItem('conv-index')!);
      expect(updatedIndex.conversationIds).toEqual(['good']);
    });

    it('quarantines invalid conversations during legacy migration', () => {
      const legacyBlob = {
        state: {
          conversations: [
            makeConversation('valid-1'),
            { id: '', name: 123, messages: 'not-array' }, // invalid
          ],
          selectedConversationId: null,
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      // valid-1 loaded + the invalid one may be auto-recovered (it has an id, albeit empty)
      expect(parsed.state.conversations.length).toBeGreaterThanOrEqual(1);
    });

    it('auto-recovers a conversation with missing fields during load', () => {
      // Store a conversation missing model, temperature, prompt — recoverable
      const partial = {
        id: 'recoverable',
        name: 'Partial Conv',
        messages: [{ role: 'user', content: 'Hello' }],
        // missing: model, temperature, prompt
      };
      localStorage.setItem('conv-data-recoverable', JSON.stringify(partial));
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['recoverable'],
          selectedConversationId: null,
          folderIds: [],
        }),
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      // Should be auto-recovered, not quarantined
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].model).toBeDefined();
      expect(parsed.state.conversations[0].temperature).toBeDefined();
      expect(getQuarantinedItems()).toHaveLength(0);
    });

    it('rebuilds index from orphaned conv-data-* keys', () => {
      // Store conversations without an index
      localStorage.setItem(
        'conv-data-orphan1',
        JSON.stringify(makeConversation('orphan1')),
      );
      localStorage.setItem(
        'conv-data-orphan2',
        JSON.stringify(makeConversation('orphan2')),
      );
      localStorage.setItem('conv-folder-f1', JSON.stringify(makeFolder('f1')));
      // No conv-index!

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(2);

      // Index should have been rebuilt and persisted
      const index = JSON.parse(localStorage.getItem('conv-index')!);
      expect(index.conversationIds).toContain('orphan1');
      expect(index.conversationIds).toContain('orphan2');
      expect(index.folderIds).toContain('f1');
    });

    it('recovers from malformed conv-index', () => {
      // Store valid conversation data
      localStorage.setItem(
        'conv-data-c1',
        JSON.stringify(makeConversation('c1')),
      );
      // Store malformed index
      localStorage.setItem('conv-index', '{"broken": true}');

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('c1');
    });

    it('returns loaded data even when index write fails during hydration', () => {
      // Set up valid per-conv data
      localStorage.setItem(
        'conv-data-c1',
        JSON.stringify(makeConversation('c1')),
      );
      // Store a corrupted conversation that will be quarantined
      localStorage.setItem('conv-data-bad', '{broken}');
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['c1', 'bad'],
          selectedConversationId: null,
          folderIds: [],
        }),
      );

      // Make index writes fail (simulating full storage after quarantine)
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(
        (key: string, value: string) => {
          if (key === 'conv-index') {
            throw new Error('QuotaExceededError');
          }
          originalSetItem(key, value);
        },
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      vi.restoreAllMocks();

      // Should still return the valid conversation despite index write failure
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('c1');
    });

    it('recovers from truncated legacy blob via JSON repair', () => {
      // Simulate a truncated legacy blob (missing closing brackets)
      const truncatedBlob =
        '{"state":{"conversations":[{"id":"rescued","name":"Truncated","messages":[],"model":{"id":"gpt-4","name":"GPT-4"},"temperature":0.7,"prompt":"","folderId":null}],"selectedConversationId":null,"folders":[]},"version":4';
      // Note: missing final closing brace

      localStorage.setItem('conversation-storage', truncatedBlob);

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(1);
      expect(parsed.state.conversations[0].id).toBe('rescued');

      // Legacy blob should be cleaned up after successful repair + migration
      expect(localStorage.getItem('conversation-storage')).toBeNull();
    });

    it('strips invalid message entries and quarantines raw backup', () => {
      const conv = {
        ...makeConversation('sanitize-test'),
        messages: [
          { role: 'user', content: 'Hello' },
          null,
          'garbage',
          { role: 'assistant', content: 'Hi' },
        ],
      };
      localStorage.setItem('conv-data-sanitize-test', JSON.stringify(conv));
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['sanitize-test'],
          selectedConversationId: null,
          folderIds: [],
        }),
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      expect(parsed.state.conversations).toHaveLength(1);
      // Invalid entries should have been stripped during validation
      expect(parsed.state.conversations[0].messages).toHaveLength(2);

      // Raw data should be quarantined as backup
      const quarantined = getQuarantinedItems();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].errors[0]).toContain('invalid message');
    });
  });

  describe('setItem', () => {
    it('writes conversations to individual keys', () => {
      const state = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: 'c1',
          folders: [],
        },
        version: 5,
      };

      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(state),
      );

      expect(localStorage.getItem('conv-data-c1')).not.toBeNull();
      expect(localStorage.getItem('conv-data-c2')).not.toBeNull();

      const index = JSON.parse(localStorage.getItem('conv-index')!);
      expect(index.conversationIds).toContain('c1');
      expect(index.conversationIds).toContain('c2');
      expect(index.selectedConversationId).toBe('c1');
    });

    it('preserves existing conversation when QuotaExceededError on update', () => {
      // Write initial conversation
      const initial = {
        state: {
          conversations: [makeConversation('c1')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(initial),
      );

      const originalData = localStorage.getItem('conv-data-c1');
      expect(originalData).not.toBeNull();

      // Make setItem throw QuotaExceededError for conv-data-c1
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(
        (key: string, value: string) => {
          if (key === 'conv-data-c1') {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
          originalSetItem(key, value);
        },
      );

      // Try to update the conversation (different updatedAt forces write attempt)
      const updated = {
        state: {
          conversations: [
            {
              ...makeConversation('c1'),
              name: 'Updated Name',
              updatedAt: '2099-01-01T00:00:00Z',
            },
          ],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(updated),
      );

      vi.restoreAllMocks();

      // The original data should still be in localStorage (not deleted)
      expect(localStorage.getItem('conv-data-c1')).toBe(originalData);

      // The index should still include c1
      const index = JSON.parse(localStorage.getItem('conv-index')!);
      expect(index.conversationIds).toContain('c1');
    });

    it('persists folder renames', () => {
      // Write initial state with a folder
      const initial = {
        state: {
          conversations: [],
          selectedConversationId: null,
          folders: [makeFolder('f1', 'Original Name')],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(initial),
      );

      // Rename the folder
      const updated = {
        state: {
          conversations: [],
          selectedConversationId: null,
          folders: [makeFolder('f1', 'Renamed Folder')],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(updated),
      );

      // Verify the rename persisted
      const stored = JSON.parse(localStorage.getItem('conv-folder-f1')!);
      expect(stored.name).toBe('Renamed Folder');
    });

    it('preserves deleted keys if index write fails', () => {
      // Write initial state
      const initial = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(initial),
      );

      // Mock index write to fail
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(
        (key: string, value: string) => {
          if (key === 'conv-index') {
            throw new Error('QuotaExceededError');
          }
          originalSetItem(key, value);
        },
      );

      // Try to delete c2
      const updated = {
        state: {
          conversations: [makeConversation('c1')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(updated),
      );

      vi.restoreAllMocks();

      // c2 should NOT have been deleted (index write failed, so deletions were skipped)
      expect(localStorage.getItem('conv-data-c2')).not.toBeNull();
    });

    it('preserves newer per-conv keys when legacy blob still exists', () => {
      // Simulate: user edited a conversation during session, but index write failed
      // so legacy blob is still present with stale data
      const newerConv = {
        ...makeConversation('c1'),
        name: 'Updated in current session',
        updatedAt: '2099-01-01T00:00:00Z',
      };
      localStorage.setItem('conv-data-c1', JSON.stringify(newerConv));

      const legacyBlob = {
        state: {
          conversations: [
            { ...makeConversation('c1'), name: 'Old from legacy' },
            makeConversation('c2'),
          ],
          selectedConversationId: null,
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      // Should have both conversations
      expect(parsed.state.conversations).toHaveLength(2);

      // c1 should have the NEWER name (not overwritten by legacy blob)
      const c1 = parsed.state.conversations.find(
        (c: { id: string }) => c.id === 'c1',
      );
      expect(c1.name).toBe('Updated in current session');

      // Legacy blob should be cleaned up
      expect(localStorage.getItem('conversation-storage')).toBeNull();
    });

    it('retries legacy migration when orphaned keys exist alongside legacy blob', () => {
      // Simulate a failed migration: some conv-data-* keys + legacy blob still present
      localStorage.setItem(
        'conv-data-partial',
        JSON.stringify(makeConversation('partial')),
      );
      const legacyBlob = {
        state: {
          conversations: [
            makeConversation('partial'),
            makeConversation('full'),
          ],
          selectedConversationId: null,
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));
      // No conv-index — simulates failed index write during previous migration

      const raw = perConversationStorage.getItem('conversation-storage');
      const parsed = JSON.parse(raw!);

      // Should have both conversations (full migration retried, not partial rebuild)
      expect(parsed.state.conversations).toHaveLength(2);
      // Legacy blob should now be removed (migration succeeded)
      expect(localStorage.getItem('conversation-storage')).toBeNull();
    });

    it('skips automatic migration and preserves blob on quota pressure', () => {
      const legacyBlob = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: 'c1',
          folders: [],
        },
        version: 4,
      };
      const blobString = JSON.stringify(legacyBlob);
      localStorage.setItem('conversation-storage', blobString);

      // Fill storage so that available < 50% of blob size
      // Blob size in bytes = blobString.length * 2 (UTF-16)
      // Preflight: max=5MB, threshold = blobSizeBytes * 0.5
      // We need totalStorageBytes > maxStorage - (blobSizeBytes * 0.5)
      const blobSizeBytes = blobString.length * 2;
      const maxStorage = 5 * 1024 * 1024;
      const targetTotal = maxStorage - Math.floor(blobSizeBytes * 0.5) + 100;
      // Current total includes the blob key + value
      const currentKeyOverhead =
        ('conversation-storage'.length + blobString.length) * 2;
      const fillNeeded = Math.max(0, targetTotal - currentKeyOverhead);
      const fillKeyOverhead = '_filler'.length * 2;
      const fillValueChars = Math.floor((fillNeeded - fillKeyOverhead) / 2);
      if (fillValueChars > 0) {
        localStorage.setItem('_filler', 'x'.repeat(fillValueChars));
      }

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.state.conversations).toHaveLength(2);

      // Legacy blob should be PRESERVED (not deleted) for MigrationDialog
      expect(localStorage.getItem('conversation-storage')).not.toBeNull();

      // No per-conversation keys should have been written
      expect(localStorage.getItem('conv-data-c1')).toBeNull();
      expect(localStorage.getItem('conv-data-c2')).toBeNull();
    });

    it('rolls back partial migration on quota failure mid-write', () => {
      const legacyBlob = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: null,
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      // Make the second conv write fail with QuotaExceededError
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(
        (key: string, value: string) => {
          if (key === 'conv-data-c2') {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
          originalSetItem(key, value);
        },
      );

      const raw = perConversationStorage.getItem('conversation-storage');
      vi.restoreAllMocks();

      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);

      // Should return all conversations for in-memory use (from blob parse)
      expect(parsed.state.conversations).toHaveLength(2);

      // Legacy blob preserved
      expect(localStorage.getItem('conversation-storage')).not.toBeNull();

      // Partial writes rolled back (c1 was written before c2 failed)
      expect(localStorage.getItem('conv-data-c1')).toBeNull();
    });

    it('does not pollute conv-index when migration is deferred under existing index', () => {
      // Set up an existing per-conv index with one conversation
      localStorage.setItem(
        'conv-data-existing',
        JSON.stringify(makeConversation('existing')),
      );
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['existing'],
          selectedConversationId: 'existing',
          folderIds: [],
        }),
      );

      // Also have a legacy blob with additional conversations (failed previous migration)
      const legacyBlob = {
        state: {
          conversations: [
            makeConversation('existing'),
            makeConversation('blob-only'),
          ],
          selectedConversationId: null,
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      // Fill storage to trigger quota-pressure deferral
      const blobString = JSON.stringify(legacyBlob);
      const blobSizeBytes = blobString.length * 2;
      const maxStorage = 5 * 1024 * 1024;
      const targetTotal = maxStorage - Math.floor(blobSizeBytes * 0.5) + 100;
      let currentTotal = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          const v = localStorage.getItem(k);
          if (v !== null) currentTotal += (k.length + v.length) * 2;
        }
      }
      const fillNeeded = Math.max(0, targetTotal - currentTotal);
      const fillKeyOverhead = '_filler'.length * 2;
      const fillValueChars = Math.floor((fillNeeded - fillKeyOverhead) / 2);
      if (fillValueChars > 0) {
        localStorage.setItem('_filler', 'x'.repeat(fillValueChars));
      }

      const raw = perConversationStorage.getItem('conversation-storage');
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      // Both conversations available in-memory
      expect(parsed.state.conversations).toHaveLength(2);

      // conv-index should NOT have been updated with 'blob-only'
      const indexAfter = JSON.parse(localStorage.getItem('conv-index')!);
      expect(indexAfter.conversationIds).toContain('existing');
      expect(indexAfter.conversationIds).not.toContain('blob-only');

      // Legacy blob preserved
      expect(localStorage.getItem('conversation-storage')).not.toBeNull();
    });

    it('setItem persists deferred blob conversations normally once space is available', () => {
      // Set up existing index + deferred blob
      localStorage.setItem(
        'conv-data-existing',
        JSON.stringify(makeConversation('existing')),
      );
      localStorage.setItem(
        'conv-index',
        JSON.stringify({
          version: 5,
          conversationIds: ['existing'],
          selectedConversationId: 'existing',
          folderIds: [],
        }),
      );

      const legacyBlob = {
        state: {
          conversations: [
            makeConversation('existing'),
            makeConversation('from-blob'),
          ],
          selectedConversationId: 'from-blob',
          folders: [],
        },
        version: 4,
      };
      localStorage.setItem('conversation-storage', JSON.stringify(legacyBlob));

      // Fill storage to trigger deferral
      const blobString = JSON.stringify(legacyBlob);
      const blobSizeBytes = blobString.length * 2;
      const maxStorage = 5 * 1024 * 1024;
      const targetTotal = maxStorage - Math.floor(blobSizeBytes * 0.5) + 100;
      let currentTotal = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          const v = localStorage.getItem(k);
          if (v !== null) currentTotal += (k.length + v.length) * 2;
        }
      }
      const fillNeeded = Math.max(0, targetTotal - currentTotal);
      const fillKeyOverhead = '_filler'.length * 2;
      const fillValueChars = Math.floor((fillNeeded - fillKeyOverhead) / 2);
      if (fillValueChars > 0) {
        localStorage.setItem('_filler', 'x'.repeat(fillValueChars));
      }

      // Hydrate — loads both in-memory, migration deferred
      perConversationStorage.getItem('conversation-storage');

      // Remove filler to free space
      localStorage.removeItem('_filler');

      // setItem should now persist the blob-origin conversation normally
      const stateWithBoth = {
        state: {
          conversations: [
            makeConversation('existing'),
            { ...makeConversation('from-blob'), name: 'User Edited' },
          ],
          selectedConversationId: 'from-blob',
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(stateWithBoth),
      );

      // Blob-origin conversation should now be persisted
      expect(localStorage.getItem('conv-data-from-blob')).not.toBeNull();
      const stored = JSON.parse(localStorage.getItem('conv-data-from-blob')!);
      expect(stored.name).toBe('User Edited');

      // Index should include it
      const indexAfter = JSON.parse(localStorage.getItem('conv-index')!);
      expect(indexAfter.conversationIds).toContain('from-blob');
      expect(indexAfter.selectedConversationId).toBe('from-blob');
    });

    it('removes deleted conversations', () => {
      // First write with two conversations
      const initial = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(initial),
      );

      // Now write with only c1
      const updated = {
        state: {
          conversations: [makeConversation('c1')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(updated),
      );

      expect(localStorage.getItem('conv-data-c1')).not.toBeNull();
      expect(localStorage.getItem('conv-data-c2')).toBeNull();
    });
  });

  describe('removeItem', () => {
    it('cleans up all per-conversation keys', () => {
      const state = {
        state: {
          conversations: [makeConversation('c1')],
          selectedConversationId: null,
          folders: [makeFolder('f1')],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(state),
      );

      perConversationStorage.removeItem('conversation-storage');

      expect(localStorage.getItem('conv-index')).toBeNull();
      expect(localStorage.getItem('conv-data-c1')).toBeNull();
      expect(localStorage.getItem('conv-folder-f1')).toBeNull();
    });
  });

  describe('utility functions', () => {
    it('getPerConversationStorageKeys returns all keys', () => {
      const state = {
        state: {
          conversations: [makeConversation('c1'), makeConversation('c2')],
          selectedConversationId: null,
          folders: [makeFolder('f1')],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(state),
      );

      const keys = getPerConversationStorageKeys();
      expect(keys).toContain('conv-index');
      expect(keys).toContain('conv-data-c1');
      expect(keys).toContain('conv-data-c2');
      expect(keys).toContain('conv-folder-f1');
    });

    it('clearAllConversationStorage removes everything', () => {
      const state = {
        state: {
          conversations: [makeConversation('c1')],
          selectedConversationId: null,
          folders: [],
        },
        version: 5,
      };
      perConversationStorage.setItem(
        'conversation-storage',
        JSON.stringify(state),
      );

      clearAllConversationStorage();

      expect(localStorage.getItem('conv-index')).toBeNull();
      expect(localStorage.getItem('conv-data-c1')).toBeNull();
    });
  });
});
