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

// Mock window.confirm
global.confirm = vi.fn(() => true);

describe('useChatActions', () => {
  const mockUpdateConversation = vi.fn();
  const mockSendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.conversations = [];
    mockState.selectedConversationId = null;
  });

  describe('handleClearAll', () => {
    it('should clear all messages from conversation', () => {
      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test Conversation',
        messages: [
          { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
          { role: 'assistant', content: 'Hi', messageType: MessageType.TEXT },
        ],
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
        result.current.handleClearAll();
      });

      expect(global.confirm).toHaveBeenCalledWith(
        'Are you sure you want to clear this conversation?',
      );
      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        messages: [],
      });
    });

    it('should not clear messages if user cancels', () => {
      (global.confirm as any).mockReturnValueOnce(false);

      const conversation: Conversation = {
        id: 'conv-1',
        name: 'Test Conversation',
        messages: [
          { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
        ],
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
        result.current.handleClearAll();
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });
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
    it('should remove messages after last user message and resend', () => {
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

      const expectedMessages = messages.slice(0, 3); // Up to and including last user message

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        messages: expectedMessages,
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        messages[2], // Last user message
        expect.objectContaining({
          id: 'conv-1',
          messages: expectedMessages,
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
