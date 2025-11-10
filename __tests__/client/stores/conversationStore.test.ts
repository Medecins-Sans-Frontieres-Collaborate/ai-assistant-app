import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('conversationStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: false,
    });
  });

  describe('Initial State', () => {
    it('has correct initial state', () => {
      const state = useConversationStore.getState();

      expect(state.conversations).toEqual([]);
      expect(state.selectedConversationId).toBeNull();
      expect(state.folders).toEqual([]);
      expect(state.searchTerm).toBe('');
      expect(state.isLoaded).toBe(false);
    });
  });

  describe('Conversation Management', () => {
    const createMockConversation = (
      id: string,
      name: string,
    ): Conversation => ({
      id,
      name,
      messages: [],
      model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
      prompt: '',
      temperature: 0.7,
      folderId: null,
    });

    describe('setConversations', () => {
      it('sets conversations array', () => {
        const conversations = [
          createMockConversation('1', 'First'),
          createMockConversation('2', 'Second'),
        ];

        useConversationStore.getState().setConversations(conversations);

        expect(useConversationStore.getState().conversations).toEqual(
          conversations,
        );
      });

      it('replaces existing conversations', () => {
        const first = [createMockConversation('1', 'First')];
        const second = [createMockConversation('2', 'Second')];

        useConversationStore.getState().setConversations(first);
        useConversationStore.getState().setConversations(second);

        expect(useConversationStore.getState().conversations).toEqual(second);
      });

      it('can set empty array', () => {
        useConversationStore
          .getState()
          .setConversations([createMockConversation('1', 'Test')]);
        useConversationStore.getState().setConversations([]);

        expect(useConversationStore.getState().conversations).toEqual([]);
      });
    });

    describe('addConversation', () => {
      it('adds conversation to empty list', () => {
        const conversation = createMockConversation('1', 'Test');

        useConversationStore.getState().addConversation(conversation);

        expect(useConversationStore.getState().conversations).toHaveLength(1);
        expect(useConversationStore.getState().conversations[0]).toEqual(
          conversation,
        );
      });

      it('adds conversation to existing list', () => {
        const first = createMockConversation('1', 'First');
        const second = createMockConversation('2', 'Second');

        useConversationStore.getState().addConversation(first);
        useConversationStore.getState().addConversation(second);

        expect(useConversationStore.getState().conversations).toHaveLength(2);
        // New conversations are prepended (added to the front)
        expect(useConversationStore.getState().conversations).toEqual([
          second,
          first,
        ]);
      });

      it('auto-selects newly added conversation', () => {
        const conversation = createMockConversation('1', 'Test');

        useConversationStore.getState().addConversation(conversation);

        expect(useConversationStore.getState().selectedConversationId).toBe(
          '1',
        );
      });

      it('updates selection when adding multiple conversations', () => {
        const first = createMockConversation('1', 'First');
        const second = createMockConversation('2', 'Second');

        useConversationStore.getState().addConversation(first);
        expect(useConversationStore.getState().selectedConversationId).toBe(
          '1',
        );

        useConversationStore.getState().addConversation(second);
        expect(useConversationStore.getState().selectedConversationId).toBe(
          '2',
        );
      });
    });

    describe('updateConversation', () => {
      it('updates conversation name', () => {
        const conversation = createMockConversation('1', 'Original');
        useConversationStore.getState().setConversations([conversation]);

        useConversationStore
          .getState()
          .updateConversation('1', { name: 'Updated' });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.name).toBe('Updated');
      });

      it('updates conversation messages', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const newMessages = [
          { role: 'user' as const, content: 'Hello', messageType: undefined },
        ];
        useConversationStore
          .getState()
          .updateConversation('1', { messages: newMessages });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.messages).toEqual(newMessages);
      });

      it('adds updatedAt timestamp', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const before = Date.now();
        useConversationStore
          .getState()
          .updateConversation('1', { name: 'Updated' });
        const after = Date.now();

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.updatedAt).toBeDefined();

        const updatedTime = new Date(updated.updatedAt!).getTime();
        expect(updatedTime).toBeGreaterThanOrEqual(before);
        expect(updatedTime).toBeLessThanOrEqual(after);
      });

      it('only updates matching conversation', () => {
        const conversations = [
          createMockConversation('1', 'First'),
          createMockConversation('2', 'Second'),
          createMockConversation('3', 'Third'),
        ];
        useConversationStore.getState().setConversations(conversations);

        useConversationStore
          .getState()
          .updateConversation('2', { name: 'Updated' });

        const all = useConversationStore.getState().conversations;
        expect(all[0].name).toBe('First');
        expect(all[1].name).toBe('Updated');
        expect(all[2].name).toBe('Third');
      });

      it('does nothing if conversation not found', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        useConversationStore
          .getState()
          .updateConversation('999', { name: 'Updated' });

        expect(useConversationStore.getState().conversations[0].name).toBe(
          'Test',
        );
      });

      it('updates multiple fields at once', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        useConversationStore.getState().updateConversation('1', {
          name: 'New Name',
          temperature: 0.9,
          folderId: 'folder-1',
        });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.name).toBe('New Name');
        expect(updated.temperature).toBe(0.9);
        expect(updated.folderId).toBe('folder-1');
      });
    });

    describe('deleteConversation', () => {
      it('deletes conversation from list', () => {
        const conversations = [
          createMockConversation('1', 'First'),
          createMockConversation('2', 'Second'),
        ];
        useConversationStore.getState().setConversations(conversations);

        useConversationStore.getState().deleteConversation('1');

        const remaining = useConversationStore.getState().conversations;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe('2');
      });

      it('clears selection if deleting selected conversation', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);
        useConversationStore.getState().selectConversation('1');

        useConversationStore.getState().deleteConversation('1');

        expect(
          useConversationStore.getState().selectedConversationId,
        ).toBeNull();
      });

      it('preserves selection if deleting different conversation', () => {
        const conversations = [
          createMockConversation('1', 'First'),
          createMockConversation('2', 'Second'),
        ];
        useConversationStore.getState().setConversations(conversations);
        useConversationStore.getState().selectConversation('1');

        useConversationStore.getState().deleteConversation('2');

        expect(useConversationStore.getState().selectedConversationId).toBe(
          '1',
        );
      });

      it('handles deleting non-existent conversation', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        useConversationStore.getState().deleteConversation('999');

        expect(useConversationStore.getState().conversations).toHaveLength(1);
      });

      it('can delete last conversation', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        useConversationStore.getState().deleteConversation('1');

        expect(useConversationStore.getState().conversations).toEqual([]);
      });
    });

    describe('selectConversation', () => {
      it('sets selected conversation ID', () => {
        useConversationStore.getState().selectConversation('123');

        expect(useConversationStore.getState().selectedConversationId).toBe(
          '123',
        );
      });

      it('can change selection', () => {
        useConversationStore.getState().selectConversation('1');
        expect(useConversationStore.getState().selectedConversationId).toBe(
          '1',
        );

        useConversationStore.getState().selectConversation('2');
        expect(useConversationStore.getState().selectedConversationId).toBe(
          '2',
        );
      });

      it('can clear selection with null', () => {
        useConversationStore.getState().selectConversation('1');
        useConversationStore.getState().selectConversation(null);

        expect(
          useConversationStore.getState().selectedConversationId,
        ).toBeNull();
      });
    });

    describe('setIsLoaded', () => {
      it('sets isLoaded to true', () => {
        useConversationStore.getState().setIsLoaded(true);

        expect(useConversationStore.getState().isLoaded).toBe(true);
      });

      it('sets isLoaded to false', () => {
        useConversationStore.getState().setIsLoaded(true);
        useConversationStore.getState().setIsLoaded(false);

        expect(useConversationStore.getState().isLoaded).toBe(false);
      });
    });

    describe('Model Switching Scenarios', () => {
      it('updates conversation model', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: newModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.id).toBe('gpt-5');
        expect(updated.model.name).toBe('GPT-5');
      });

      it('preserves messages when switching models', () => {
        const conversation = createMockConversation('1', 'Test');
        const messages = [
          { role: 'user' as const, content: 'Hello', messageType: undefined },
          {
            role: 'assistant' as const,
            content: 'Hi there!',
            messageType: undefined,
          },
        ];
        conversation.messages = messages;
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: newModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.messages).toEqual(messages);
        expect(updated.model.id).toBe('gpt-5');
      });

      it('switches from standard model to agent model', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const agentModel = {
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 16000,
          isAgent: true,
          agentId: 'agent-123',
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: agentModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.isAgent).toBe(true);
        expect(updated.model.agentId).toBe('agent-123');
      });

      it('switches from one agent model to another', () => {
        const conversation = {
          ...createMockConversation('1', 'Test'),
          model: {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            maxLength: 128000,
            tokenLimit: 16000,
            isAgent: true,
            agentId: 'agent-123',
          },
        };
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: newModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.id).toBe('gpt-5');
        expect(updated.model.isAgent).toBeUndefined();
        expect(updated.model.agentId).toBeUndefined();
      });

      it('switches from agent model to standard model', () => {
        const conversation = {
          ...createMockConversation('1', 'Test'),
          model: {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            maxLength: 128000,
            tokenLimit: 16000,
            isAgent: true,
            agentId: 'agent-123',
          },
        };
        useConversationStore.getState().setConversations([conversation]);

        const standardModel = {
          id: 'grok-3',
          name: 'Grok 3',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: standardModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.id).toBe('grok-3');
        expect(updated.model.isAgent).toBeUndefined();
        expect(updated.model.agentId).toBeUndefined();
      });

      it('updates model-specific properties', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const modelWithSpecialProps = {
          id: 'o3',
          name: 'o3',
          maxLength: 128000,
          tokenLimit: 16000,
          reasoningEffort: 'high',
          verbosity: 'medium',
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: modelWithSpecialProps as any });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.reasoningEffort).toBe('high');
        expect(updated.model.verbosity).toBe('medium');
      });

      it('preserves conversation settings when switching models', () => {
        const conversation = {
          ...createMockConversation('1', 'Test'),
          temperature: 0.8,
          folderId: 'folder-1',
          prompt: 'Custom system prompt',
        };
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: newModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.temperature).toBe(0.8);
        expect(updated.folderId).toBe('folder-1');
        expect(updated.prompt).toBe('Custom system prompt');
        expect(updated.model.id).toBe('gpt-5');
      });

      it('handles multiple rapid model switches', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const model1 = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        const model2 = {
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        const model3 = {
          id: 'o3',
          name: 'o3',
          maxLength: 128000,
          tokenLimit: 16000,
        };

        useConversationStore
          .getState()
          .updateConversation('1', { model: model1 });
        useConversationStore
          .getState()
          .updateConversation('1', { model: model2 });
        useConversationStore
          .getState()
          .updateConversation('1', { model: model3 });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.id).toBe('o3');
      });

      it('switches models while preserving bot/RAG configuration', () => {
        const conversation = {
          ...createMockConversation('1', 'Test'),
          bot: 'bot-123',
          threadId: 'thread-abc',
        };
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore
          .getState()
          .updateConversation('1', { model: newModel });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.bot).toBe('bot-123');
        expect(updated.threadId).toBe('thread-abc');
        expect(updated.model.id).toBe('gpt-5');
      });

      it('can update model and other fields simultaneously', () => {
        const conversation = createMockConversation('1', 'Test');
        useConversationStore.getState().setConversations([conversation]);

        const newModel = {
          id: 'gpt-5',
          name: 'GPT-5',
          maxLength: 128000,
          tokenLimit: 16000,
        };
        useConversationStore.getState().updateConversation('1', {
          model: newModel,
          name: 'Updated Name',
          temperature: 0.9,
        });

        const updated = useConversationStore.getState().conversations[0];
        expect(updated.model.id).toBe('gpt-5');
        expect(updated.name).toBe('Updated Name');
        expect(updated.temperature).toBe(0.9);
      });
    });
  });

  describe('Folder Management', () => {
    const createMockConversation = (
      id: string,
      name: string,
    ): Conversation => ({
      id,
      name,
      messages: [],
      model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
      prompt: '',
      temperature: 0.7,
      folderId: null,
    });

    const createMockFolder = (id: string, name: string): FolderInterface => ({
      id,
      name,
      type: 'chat',
    });

    describe('setFolders', () => {
      it('sets folders array', () => {
        const folders = [
          createMockFolder('1', 'Work'),
          createMockFolder('2', 'Personal'),
        ];

        useConversationStore.getState().setFolders(folders);

        expect(useConversationStore.getState().folders).toEqual(folders);
      });

      it('replaces existing folders', () => {
        const first = [createMockFolder('1', 'First')];
        const second = [createMockFolder('2', 'Second')];

        useConversationStore.getState().setFolders(first);
        useConversationStore.getState().setFolders(second);

        expect(useConversationStore.getState().folders).toEqual(second);
      });
    });

    describe('addFolder', () => {
      it('adds folder to empty list', () => {
        const folder = createMockFolder('1', 'Work');

        useConversationStore.getState().addFolder(folder);

        expect(useConversationStore.getState().folders).toHaveLength(1);
        expect(useConversationStore.getState().folders[0]).toEqual(folder);
      });

      it('adds folder to existing list', () => {
        const first = createMockFolder('1', 'Work');
        const second = createMockFolder('2', 'Personal');

        useConversationStore.getState().addFolder(first);
        useConversationStore.getState().addFolder(second);

        expect(useConversationStore.getState().folders).toHaveLength(2);
        expect(useConversationStore.getState().folders).toEqual([
          first,
          second,
        ]);
      });
    });

    describe('updateFolder', () => {
      it('updates folder name', () => {
        const folder = createMockFolder('1', 'Original');
        useConversationStore.getState().setFolders([folder]);

        useConversationStore.getState().updateFolder('1', 'Updated');

        expect(useConversationStore.getState().folders[0].name).toBe('Updated');
      });

      it('only updates matching folder', () => {
        const folders = [
          createMockFolder('1', 'First'),
          createMockFolder('2', 'Second'),
        ];
        useConversationStore.getState().setFolders(folders);

        useConversationStore.getState().updateFolder('1', 'Updated');

        const all = useConversationStore.getState().folders;
        expect(all[0].name).toBe('Updated');
        expect(all[1].name).toBe('Second');
      });

      it('does nothing if folder not found', () => {
        const folder = createMockFolder('1', 'Test');
        useConversationStore.getState().setFolders([folder]);

        useConversationStore.getState().updateFolder('999', 'Updated');

        expect(useConversationStore.getState().folders[0].name).toBe('Test');
      });
    });

    describe('deleteFolder', () => {
      it('deletes folder from list', () => {
        const folders = [
          createMockFolder('1', 'First'),
          createMockFolder('2', 'Second'),
        ];
        useConversationStore.getState().setFolders(folders);

        useConversationStore.getState().deleteFolder('1');

        const remaining = useConversationStore.getState().folders;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe('2');
      });

      it('removes folder from conversations', () => {
        const folder = createMockFolder('folder-1', 'Work');
        const conversations = [
          { ...createMockConversation('1', 'Test 1'), folderId: 'folder-1' },
          { ...createMockConversation('2', 'Test 2'), folderId: 'folder-1' },
          { ...createMockConversation('3', 'Test 3'), folderId: null },
        ];

        useConversationStore.getState().setFolders([folder]);
        useConversationStore
          .getState()
          .setConversations(conversations as Conversation[]);

        useConversationStore.getState().deleteFolder('folder-1');

        const all = useConversationStore.getState().conversations;
        expect(all[0].folderId).toBeNull();
        expect(all[1].folderId).toBeNull();
        expect(all[2].folderId).toBeNull();
      });

      it('only removes folder from affected conversations', () => {
        const folders = [
          createMockFolder('folder-1', 'Work'),
          createMockFolder('folder-2', 'Personal'),
        ];
        const conversations = [
          { ...createMockConversation('1', 'Test 1'), folderId: 'folder-1' },
          { ...createMockConversation('2', 'Test 2'), folderId: 'folder-2' },
        ];

        useConversationStore.getState().setFolders(folders);
        useConversationStore
          .getState()
          .setConversations(conversations as Conversation[]);

        useConversationStore.getState().deleteFolder('folder-1');

        const all = useConversationStore.getState().conversations;
        expect(all[0].folderId).toBeNull();
        expect(all[1].folderId).toBe('folder-2');
      });

      it('handles deleting non-existent folder', () => {
        const folder = createMockFolder('1', 'Test');
        useConversationStore.getState().setFolders([folder]);

        useConversationStore.getState().deleteFolder('999');

        expect(useConversationStore.getState().folders).toHaveLength(1);
      });
    });
  });

  describe('Search', () => {
    describe('setSearchTerm', () => {
      it('sets search term', () => {
        useConversationStore.getState().setSearchTerm('test query');

        expect(useConversationStore.getState().searchTerm).toBe('test query');
      });

      it('updates search term', () => {
        useConversationStore.getState().setSearchTerm('first');
        useConversationStore.getState().setSearchTerm('second');

        expect(useConversationStore.getState().searchTerm).toBe('second');
      });

      it('can clear search term', () => {
        useConversationStore.getState().setSearchTerm('search');
        useConversationStore.getState().setSearchTerm('');

        expect(useConversationStore.getState().searchTerm).toBe('');
      });
    });
  });

  describe('Bulk Operations', () => {
    describe('clearAll', () => {
      it('clears all conversations and folders', () => {
        const conversation = { id: '1', name: 'Test' } as Conversation;
        const folder = { id: 'f1', name: 'Work', type: 'chat' as const };

        useConversationStore.setState({
          conversations: [conversation],
          selectedConversationId: '1',
          folders: [folder],
          searchTerm: 'search',
        });

        useConversationStore.getState().clearAll();

        const state = useConversationStore.getState();
        expect(state.conversations).toEqual([]);
        expect(state.selectedConversationId).toBeNull();
        expect(state.folders).toEqual([]);
        expect(state.searchTerm).toBe('');
      });

      it('can be called on empty state', () => {
        useConversationStore.getState().clearAll();

        const state = useConversationStore.getState();
        expect(state.conversations).toEqual([]);
        expect(state.folders).toEqual([]);
      });

      it('preserves isLoaded flag', () => {
        useConversationStore.setState({ isLoaded: true });

        useConversationStore.getState().clearAll();

        expect(useConversationStore.getState().isLoaded).toBe(true);
      });
    });
  });

  describe('State Isolation', () => {
    it('changes do not affect subsequent tests', () => {
      const conversation = { id: '1', name: 'Test' } as Conversation;
      const folder = { id: 'f1', name: 'Work', type: 'chat' as const };

      useConversationStore.getState().setConversations([conversation]);
      useConversationStore.getState().setFolders([folder]);
      useConversationStore.getState().setSearchTerm('search');
      useConversationStore.getState().selectConversation('1');

      // Manually reset (beforeEach also does this)
      useConversationStore.setState({
        conversations: [],
        selectedConversationId: null,
        folders: [],
        searchTerm: '',
        isLoaded: false,
      });

      const state = useConversationStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.selectedConversationId).toBeNull();
      expect(state.folders).toEqual([]);
      expect(state.searchTerm).toBe('');
    });
  });
});
