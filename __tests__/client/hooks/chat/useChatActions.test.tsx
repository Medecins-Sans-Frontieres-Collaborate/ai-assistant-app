import { act, renderHook } from '@testing-library/react';

import { useChatActions } from '@/client/hooks/chat/useChatActions';

import { Conversation, Message, MessageType } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the conversation store
const mockState = {
  conversations: [] as Conversation[],
  selectedConversationId: null as string | null,
};

vi.mock('@/client/stores/conversationStore', () => ({
  useConversationStore: {
    getState: vi.fn(() => mockState),
  },
}));

// Mock the chat store
const mockChatState = {
  setRegeneratingIndex: vi.fn(),
};

vi.mock('@/client/stores/chatStore', () => ({
  useChatStore: {
    getState: vi.fn(() => mockChatState),
  },
}));

describe('useChatActions', () => {
  const mockUpdateConversation = vi.fn();
  const mockSendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.conversations = [];
    mockState.selectedConversationId = null;
    mockChatState.setRegeneratingIndex.mockClear();
  });

  describe('handleEditMessage', () => {
    it('should update the edited message', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Original', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Response',
          messageType: MessageType.TEXT,
        },
      ];

      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages,
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      const editedMessage: Message = {
        ...messages[0],
        content: 'Edited content',
      };

      act(() => {
        result.current.handleEditMessage(editedMessage);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        messages: [editedMessage, messages[1]],
      });
      // No compaction stored → nothing to invalidate
      expect('compaction' in mockUpdateConversation.mock.calls[0][1]).toBe(
        false,
      );
    });

    it('invalidates compaction when the edited message lies inside the summarized region', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q1', messageType: MessageType.TEXT },
        { role: 'assistant', content: 'A1', messageType: MessageType.TEXT },
        {
          role: 'user',
          content: 'Q2',
          messageType: MessageType.TEXT,
          promptId: 'p2',
        },
        { role: 'assistant', content: 'A2', messageType: MessageType.TEXT },
      ];

      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages,
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
        compaction: {
          summary: 'covers entries 1..1',
          upToEntryIndex: 2,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      // Edit the first user message (flat index 0 < upToEntryIndex 2): the
      // old fact is baked into the summary, so the watermark must be cleared
      // for the next post-stream refresh to rebuild it.
      act(() => {
        result.current.handleEditMessage({
          ...messages[0],
          content: 'Q1 corrected',
        });
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        messages: [
          { ...messages[0], content: 'Q1 corrected' },
          messages[1],
          messages[2],
          messages[3],
        ],
        compaction: undefined,
      });
      expect('compaction' in mockUpdateConversation.mock.calls[0][1]).toBe(
        true,
      );
    });

    it('keeps compaction when the edited message lies beyond the summarized region', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q1', messageType: MessageType.TEXT },
        { role: 'assistant', content: 'A1', messageType: MessageType.TEXT },
        {
          role: 'user',
          content: 'Q2',
          messageType: MessageType.TEXT,
          promptId: 'p2',
        },
        { role: 'assistant', content: 'A2', messageType: MessageType.TEXT },
      ];

      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages,
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
        compaction: {
          summary: 'covers entries 1..1',
          upToEntryIndex: 2,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      // Edit the second user message (flat index 2, not < upToEntryIndex 2):
      // the summary doesn't cover it, so it stays valid.
      act(() => {
        result.current.handleEditMessage({
          ...messages[2],
          content: 'Q2 corrected',
        });
      });

      expect(mockUpdateConversation).toHaveBeenCalledTimes(1);
      expect('compaction' in mockUpdateConversation.mock.calls[0][1]).toBe(
        false,
      );
    });
  });

  describe('handleSend', () => {
    it('should add message and call sendMessage', () => {
      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      const newMessage: Message = {
        role: 'user',
        content: 'Hello AI',
        messageType: MessageType.TEXT,
      };

      act(() => {
        result.current.handleSend(newMessage, SearchMode.INTELLIGENT);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        messages: [newMessage],
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        newMessage,
        expect.objectContaining({
          id: 'conv-1',
          messages: [newMessage],
        }),
        SearchMode.INTELLIGENT,
      );
    });

    it('should not send if no conversation selected', () => {
      mockState.conversations = [];
      mockState.selectedConversationId = null;

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      const newMessage: Message = {
        role: 'user',
        content: 'Hello',
        messageType: MessageType.TEXT,
      };

      act(() => {
        result.current.handleSend(newMessage);
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleSelectPrompt', () => {
    it('should send prompt text as user message', () => {
      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      act(() => {
        result.current.handleSelectPrompt('Write a story about a robot');
      });

      expect(mockUpdateConversation).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'Write a story about a robot',
          messageType: MessageType.TEXT,
        }),
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('handleRegenerate', () => {
    it('should set regenerating index and resend last user message', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Question 1', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Answer 1',
          messageType: MessageType.TEXT,
        },
        { role: 'user', content: 'Question 2', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Answer 2',
          messageType: MessageType.TEXT,
        },
      ];

      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages,
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      act(() => {
        result.current.handleRegenerate();
      });

      // Should set the regenerating index to the last assistant message (index 3)
      expect(mockChatState.setRegeneratingIndex).toHaveBeenCalledWith(3);

      // Should send the last user message with a sliced conversation for the API
      // The API conversation should only include messages up to the user message (indices 0-2)
      expect(mockSendMessage).toHaveBeenCalledWith(
        messages[2], // Last user message
        expect.objectContaining({
          id: 'conv-1',
          messages: messages.slice(0, 3), // Messages up to and including user message
        }),
        undefined,
      );
    });

    it('should not regenerate if no messages exist', () => {
      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: { id: 'gpt-4', name: 'GPT-4' } as any,
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      mockState.conversations = [conversation];
      mockState.selectedConversationId = 'conv-1';

      const { result } = renderHook(() =>
        useChatActions({
          updateConversation: mockUpdateConversation,
          sendMessage: mockSendMessage,
        }),
      );

      act(() => {
        result.current.handleRegenerate();
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });
});
