import { act, renderHook } from '@testing-library/react';

import { useChat } from '@/client/hooks/chat/useChat';

import { MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useChatStore } from '@/client/stores/chatStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for useChat hook
 * This hook wraps the chatStore to provide chat-related state and actions
 */
describe('useChat', () => {
  beforeEach(() => {
    // Reset store before each test
    useChatStore.setState({
      currentMessage: undefined,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      citations: [],
      error: null,
      stopRequested: false,
      loadingMessage: null,
    });
  });

  describe('State Access', () => {
    it('exposes currentMessage from store', () => {
      const testMessage = {
        role: 'user' as const,
        content: 'Test message',
        messageType: MessageType.TEXT,
      };

      useChatStore.setState({ currentMessage: testMessage });

      const { result } = renderHook(() => useChat());

      expect(result.current.currentMessage).toEqual(testMessage);
    });

    it('exposes isStreaming from store', () => {
      useChatStore.setState({ isStreaming: true });

      const { result } = renderHook(() => useChat());

      expect(result.current.isStreaming).toBe(true);
    });

    it('exposes streamingContent from store', () => {
      useChatStore.setState({ streamingContent: 'Streaming...' });

      const { result } = renderHook(() => useChat());

      expect(result.current.streamingContent).toBe('Streaming...');
    });

    it('exposes streamingConversationId from store', () => {
      useChatStore.setState({ streamingConversationId: 'conv-123' });

      const { result } = renderHook(() => useChat());

      expect(result.current.streamingConversationId).toBe('conv-123');
    });

    it('exposes citations from store', () => {
      const citations = [
        {
          number: 1,
          url: 'https://example.com',
          title: 'Example',
          date: '2024-01-01',
        },
      ];

      useChatStore.setState({ citations });

      const { result } = renderHook(() => useChat());

      expect(result.current.citations).toEqual(citations);
    });

    it('exposes error from store', () => {
      useChatStore.setState({ error: 'Test error' });

      const { result } = renderHook(() => useChat());

      expect(result.current.error).toBe('Test error');
    });

    it('exposes stopRequested from store', () => {
      useChatStore.setState({ stopRequested: true });

      const { result } = renderHook(() => useChat());

      expect(result.current.stopRequested).toBe(true);
    });

    it('exposes loadingMessage from store', () => {
      useChatStore.setState({ loadingMessage: 'Loading...' });

      const { result } = renderHook(() => useChat());

      expect(result.current.loadingMessage).toBe('Loading...');
    });
  });

  describe('Actions', () => {
    it('exposes setCurrentMessage action', () => {
      const { result } = renderHook(() => useChat());

      const testMessage = {
        role: 'assistant' as const,
        content: 'Response',
        messageType: MessageType.TEXT,
      };

      act(() => {
        result.current.setCurrentMessage(testMessage);
      });

      expect(result.current.currentMessage).toEqual(testMessage);
    });

    it('exposes setIsStreaming action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setIsStreaming(true);
      });

      expect(result.current.isStreaming).toBe(true);

      act(() => {
        result.current.setIsStreaming(false);
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it('exposes setStreamingContent action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setStreamingContent('New content');
      });

      expect(result.current.streamingContent).toBe('New content');
    });

    it('exposes appendStreamingContent action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setStreamingContent('Hello');
      });

      act(() => {
        result.current.appendStreamingContent(' World');
      });

      expect(result.current.streamingContent).toBe('Hello World');
    });

    it('exposes setCitations action', () => {
      const { result } = renderHook(() => useChat());

      const citations = [
        {
          number: 1,
          url: 'https://test.com',
          title: 'Test',
          date: '2024-01-01',
        },
      ];

      act(() => {
        result.current.setCitations(citations);
      });

      expect(result.current.citations).toEqual(citations);
    });

    it('exposes setError action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setError('Error occurred');
      });

      expect(result.current.error).toBe('Error occurred');
    });

    it('exposes clearError action', () => {
      const { result } = renderHook(() => useChat());

      // Set error first
      act(() => {
        result.current.setError('Error occurred');
      });

      expect(result.current.error).toBe('Error occurred');

      // Clear error
      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });

    it('exposes requestStop action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.requestStop();
      });

      expect(result.current.stopRequested).toBe(true);
    });

    it('exposes resetStop action', () => {
      const { result } = renderHook(() => useChat());

      // Request stop first
      act(() => {
        result.current.requestStop();
      });

      expect(result.current.stopRequested).toBe(true);

      // Reset stop
      act(() => {
        result.current.resetStop();
      });

      expect(result.current.stopRequested).toBe(false);
    });

    it('exposes setLoadingMessage action', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setLoadingMessage('Loading...');
      });

      expect(result.current.loadingMessage).toBe('Loading...');

      act(() => {
        result.current.setLoadingMessage(null);
      });

      expect(result.current.loadingMessage).toBeNull();
    });

    it('exposes resetChat action', () => {
      const { result } = renderHook(() => useChat());

      // Set various state
      act(() => {
        result.current.setIsStreaming(true);
        result.current.setStreamingContent('Content');
        result.current.setError('Error');
        result.current.requestStop();
        result.current.setLoadingMessage('Loading');
      });

      // Verify state is set
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingContent).toBe('Content');
      expect(result.current.error).toBe('Error');
      expect(result.current.stopRequested).toBe(true);
      expect(result.current.loadingMessage).toBe('Loading');

      // Reset everything
      act(() => {
        result.current.resetChat();
      });

      // Verify everything is reset
      expect(result.current.currentMessage).toBeUndefined();
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.streamingContent).toBe('');
      expect(result.current.streamingConversationId).toBeNull();
      expect(result.current.citations).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.stopRequested).toBe(false);
      expect(result.current.loadingMessage).toBeNull();
    });

    it('exposes sendMessage action', () => {
      const { result } = renderHook(() => useChat());

      // Verify sendMessage is a function
      expect(typeof result.current.sendMessage).toBe('function');

      // Note: We don't test the actual sendMessage implementation here
      // as it's complex and already tested in chatStore.metadata.test.tsx
      // We just verify that the function is exposed
    });
  });

  describe('Multiple Hook Instances', () => {
    it('shares state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useChat());
      const { result: result2 } = renderHook(() => useChat());

      // Update state in first instance
      act(() => {
        result1.current.setStreamingContent('Shared content');
      });

      // Verify both instances have the same state
      expect(result1.current.streamingContent).toBe('Shared content');
      expect(result2.current.streamingContent).toBe('Shared content');
    });

    it('shares actions across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useChat());
      const { result: result2 } = renderHook(() => useChat());

      // Call action from second instance
      act(() => {
        result2.current.setIsStreaming(true);
      });

      // Verify first instance sees the change
      expect(result1.current.isStreaming).toBe(true);
      expect(result2.current.isStreaming).toBe(true);
    });
  });

  describe('Reactivity', () => {
    it('updates when store state changes', () => {
      const { result } = renderHook(() => useChat());

      expect(result.current.streamingContent).toBe('');

      // Update store directly
      act(() => {
        useChatStore.setState({ streamingContent: 'Updated' });
      });

      expect(result.current.streamingContent).toBe('Updated');
    });

    it('maintains reactivity for all state properties', () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        useChatStore.setState({
          isStreaming: true,
          streamingContent: 'Content',
          streamingConversationId: 'conv-456',
          error: 'Error message',
          stopRequested: true,
          loadingMessage: 'Loading...',
        });
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingContent).toBe('Content');
      expect(result.current.streamingConversationId).toBe('conv-456');
      expect(result.current.error).toBe('Error message');
      expect(result.current.stopRequested).toBe(true);
      expect(result.current.loadingMessage).toBe('Loading...');
    });
  });

  describe('Type Safety', () => {
    it('returns correctly typed state and actions', () => {
      const { result } = renderHook(() => useChat());

      // State types (currentMessage can be undefined initially)
      expect(result.current.currentMessage).toBeUndefined();
      expect(typeof result.current.isStreaming).toBe('boolean');
      expect(typeof result.current.streamingContent).toBe('string');
      expect(Array.isArray(result.current.citations)).toBe(true);

      // Action types
      expect(typeof result.current.setCurrentMessage).toBe('function');
      expect(typeof result.current.setIsStreaming).toBe('function');
      expect(typeof result.current.setStreamingContent).toBe('function');
      expect(typeof result.current.appendStreamingContent).toBe('function');
      expect(typeof result.current.setCitations).toBe('function');
      expect(typeof result.current.setError).toBe('function');
      expect(typeof result.current.clearError).toBe('function');
      expect(typeof result.current.requestStop).toBe('function');
      expect(typeof result.current.resetStop).toBe('function');
      expect(typeof result.current.resetChat).toBe('function');
      expect(typeof result.current.setLoadingMessage).toBe('function');
      expect(typeof result.current.sendMessage).toBe('function');
    });
  });
});
