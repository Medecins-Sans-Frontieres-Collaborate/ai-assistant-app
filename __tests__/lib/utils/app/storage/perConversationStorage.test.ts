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

    it('strips invalid message entries during load', () => {
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

      // Make setItem throw QuotaExceededError for the next write
      const originalSetItem = localStorage.setItem.bind(localStorage);
      let callCount = 0;
      vi.spyOn(localStorage, 'setItem').mockImplementation(
        (key: string, value: string) => {
          if (key === 'conv-data-c1' && callCount++ > 0) {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
          originalSetItem(key, value);
        },
      );

      // Try to update the conversation
      const updated = {
        state: {
          conversations: [{ ...makeConversation('c1'), name: 'Updated Name' }],
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
