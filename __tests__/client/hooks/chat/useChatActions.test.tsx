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
        undefined, // codeInterpreterMode
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
        undefined, // searchMode
        undefined, // codeInterpreterMode
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
        undefined, // searchMode
        undefined, // codeInterpreterMode
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
