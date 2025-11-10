import { act, renderHook } from '@testing-library/react';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import type { Conversation } from '@/types/chat';
import type { FolderInterface } from '@/types/folder';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useConversations', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: false,
    });
  });

  const createMockConversation = (
    overrides?: Partial<Conversation>,
  ): Conversation => ({
    id: 'conv-1',
    name: 'Test Conversation',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: 'You are a helpful assistant',
    temperature: 0.7,
    folderId: null,
    ...overrides,
  });

  const createMockFolder = (
    overrides?: Partial<FolderInterface>,
  ): FolderInterface => ({
    id: 'folder-1',
    name: 'Test Folder',
    type: 'chat',
    ...overrides,
  });

  describe('Initial State', () => {
    it('returns empty conversations array', () => {
      const { result } = renderHook(() => useConversations());

      expect(result.current.conversations).toEqual([]);
    });

    it('returns null for selectedConversation', () => {
      const { result } = renderHook(() => useConversations());

      expect(result.current.selectedConversation).toBeNull();
    });

    it('returns empty folders array', () => {
      const { result } = renderHook(() => useConversations());

      expect(result.current.folders).toEqual([]);
    });

    it('returns empty searchTerm', () => {
      const { result } = renderHook(() => useConversations());

      expect(result.current.searchTerm).toBe('');
    });

    it('returns false for isLoaded', () => {
      const { result } = renderHook(() => useConversations());

      expect(result.current.isLoaded).toBe(false);
    });
  });

  describe('Conversation Management', () => {
    it('adds a conversation', () => {
      const { result } = renderHook(() => useConversations());

      const newConv = createMockConversation({ id: 'conv-1', name: 'First' });

      act(() => {
        result.current.addConversation(newConv);
      });

      expect(result.current.conversations).toHaveLength(1);
      expect(result.current.conversations[0]).toEqual(newConv);
    });

    it('updates a conversation', () => {
      const conv = createMockConversation({ id: 'conv-1', name: 'Original' });
      useConversationStore.setState({ conversations: [conv] });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.updateConversation('conv-1', { name: 'Updated' });
      });

      expect(result.current.conversations[0].name).toBe('Updated');
    });

    it('deletes a conversation', () => {
      const conv = createMockConversation({ id: 'conv-1' });
      useConversationStore.setState({ conversations: [conv] });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.deleteConversation('conv-1');
      });

      expect(result.current.conversations).toHaveLength(0);
    });
  });

  describe('Selected Conversation', () => {
    it('computes selectedConversation correctly', () => {
      const conv1 = createMockConversation({ id: 'conv-1', name: 'First' });
      const conv2 = createMockConversation({ id: 'conv-2', name: 'Second' });
      useConversationStore.setState({
        conversations: [conv1, conv2],
        selectedConversationId: 'conv-2',
      });

      const { result } = renderHook(() => useConversations());

      expect(result.current.selectedConversation).toEqual(conv2);
    });

    it('returns null when no conversation selected', () => {
      const conv = createMockConversation({ id: 'conv-1' });
      useConversationStore.setState({
        conversations: [conv],
        selectedConversationId: null,
      });

      const { result } = renderHook(() => useConversations());

      expect(result.current.selectedConversation).toBeNull();
    });

    it('selects a conversation', () => {
      const conv = createMockConversation({ id: 'conv-1' });
      useConversationStore.setState({ conversations: [conv] });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.selectConversation('conv-1');
      });

      expect(result.current.selectedConversation).toEqual(conv);
    });
  });

  describe('Search Filtering', () => {
    it('returns all conversations when search term is empty', () => {
      const convs = [
        createMockConversation({ id: 'conv-1', name: 'First' }),
        createMockConversation({ id: 'conv-2', name: 'Second' }),
      ];
      useConversationStore.setState({ conversations: convs });

      const { result } = renderHook(() => useConversations());

      expect(result.current.filteredConversations).toEqual(convs);
    });

    it('filters conversations by name', () => {
      const convs = [
        createMockConversation({ id: 'conv-1', name: 'Apple Discussion' }),
        createMockConversation({ id: 'conv-2', name: 'Banana Talk' }),
      ];
      useConversationStore.setState({ conversations: convs });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.setSearchTerm('apple');
      });

      expect(result.current.filteredConversations).toHaveLength(1);
      expect(result.current.filteredConversations[0].name).toBe(
        'Apple Discussion',
      );
    });

    it('filters conversations by message content', () => {
      const convs = [
        createMockConversation({
          id: 'conv-1',
          name: 'Chat 1',
          messages: [
            {
              role: 'user',
              content: 'Hello about Python',
              messageType: undefined,
            },
          ],
        }),
        createMockConversation({
          id: 'conv-2',
          name: 'Chat 2',
          messages: [
            {
              role: 'user',
              content: 'Hello about JavaScript',
              messageType: undefined,
            },
          ],
        }),
      ];
      useConversationStore.setState({ conversations: convs });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.setSearchTerm('python');
      });

      expect(result.current.filteredConversations).toHaveLength(1);
      expect(result.current.filteredConversations[0].id).toBe('conv-1');
    });
  });

  describe('Folder Management', () => {
    it('adds a folder', () => {
      const { result } = renderHook(() => useConversations());

      const folder = createMockFolder({ id: 'folder-1', name: 'Work' });

      act(() => {
        result.current.addFolder(folder);
      });

      expect(result.current.folders).toHaveLength(1);
      expect(result.current.folders[0]).toEqual(folder);
    });

    it('updates a folder', () => {
      const folder = createMockFolder({ id: 'folder-1', name: 'Original' });
      useConversationStore.setState({ folders: [folder] });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.updateFolder('folder-1', 'Updated');
      });

      expect(result.current.folders[0].name).toBe('Updated');
    });

    it('deletes a folder', () => {
      const folder = createMockFolder({ id: 'folder-1' });
      useConversationStore.setState({ folders: [folder] });

      const { result } = renderHook(() => useConversations());

      act(() => {
        result.current.deleteFolder('folder-1');
      });

      expect(result.current.folders).toHaveLength(0);
    });
  });
});
