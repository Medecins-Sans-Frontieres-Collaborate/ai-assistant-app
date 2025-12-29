import { Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useChatStore } from '@/client/stores/chatStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for action metadata flow in chatStore
 * Validates that action metadata is properly extracted and displayed
 */
describe('ChatStore - Action Metadata Flow', () => {
  beforeEach(() => {
    // Reset store
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

    // Mock global fetch
    global.fetch = vi.fn();
  });

  describe('Action Metadata Extraction', () => {
    it('extracts action metadata from stream', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      // Create stream with action metadata
      const mockStream = new ReadableStream({
        start(controller) {
          // Send action metadata first
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"action":"Searching the web..."}<<<METADATA_END>>>',
            ),
          );
          // Then content (delayed longer to give test time to check loading message)
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('Here is the result'));
            controller.close();
          }, 200);
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      const promise = useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      // Wait for action metadata to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if action was set
      let state = useChatStore.getState();
      expect(state.loadingMessage).toBe('Searching the web...');

      await promise;

      // After completion, loading message should be cleared
      state = useChatStore.getState();
      expect(state.loadingMessage).toBeNull();
    });

    it('updates loading message with action', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"action":"Processing..."}<<<METADATA_END>>>',
            ),
          );
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('Content'));
            controller.close();
          }, 200);
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      const promise = useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = useChatStore.getState();
      expect(state.loadingMessage).toBe('Processing...');

      await promise;
    });

    it('clears loading message when content arrives', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          // Action first
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"action":"Loading..."}<<<METADATA_END>>>',
            ),
          );
          // Then content
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('Actual content here'));
            controller.close();
          }, 50);
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      const state = useChatStore.getState();
      expect(state.loadingMessage).toBeNull();
      expect(state.streamingContent).toBe('');
    });
  });

  describe('Loading Delay (400ms)', () => {
    it('does not show loading message if response is fast', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      // Fast response (< 400ms)
      const mockStream = new ReadableStream({
        start(controller) {
          // Immediate response
          controller.enqueue(new TextEncoder().encode('Fast response'));
          controller.close();
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      const startTime = Date.now();

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      const duration = Date.now() - startTime;
      const state = useChatStore.getState();

      // Should complete quickly and not show loading message
      expect(duration).toBeLessThan(400);
      expect(state.loadingMessage).toBeNull();
    });

    it('shows loading message if response is slow (>400ms)', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      // Slow response (> 400ms)
      const mockStream = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('Slow response'));
            controller.close();
          }, 500);
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      const promise = useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      // Wait past the 400ms threshold
      await new Promise((resolve) => setTimeout(resolve, 450));

      // Should have loading message since response hasn't arrived yet
      let state = useChatStore.getState();
      expect(state.loadingMessage).not.toBeNull();

      await promise;

      // After completion, loading message should be cleared
      state = useChatStore.getState();
      expect(state.loadingMessage).toBeNull();
    });
  });

  describe('Citations Metadata', () => {
    it('extracts citations from metadata', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Content'));
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"citations":[{"number":1,"url":"https://example.com","title":"Test"}]}<<<METADATA_END>>>',
            ),
          );
          controller.close();
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      const state = useChatStore.getState();
      expect(state.citations).toHaveLength(1);
      expect(state.citations[0].url).toBe('https://example.com');
      expect(state.citations[0].title).toBe('Test');
    });

    it('handles multiple citations', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Content'));
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"citations":[{"number":1,"url":"https://a.com","title":"A"},{"number":2,"url":"https://b.com","title":"B"}]}<<<METADATA_END>>>',
            ),
          );
          controller.close();
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      const state = useChatStore.getState();
      expect(state.citations).toHaveLength(2);
      expect(state.citations[0].url).toBe('https://a.com');
      expect(state.citations[1].url).toBe('https://b.com');
    });
  });

  describe('Error Handling', () => {
    it('clears loading message on error', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      vi.mocked(global.fetch).mockRejectedValue(new Error('Test error'));

      // Set initial loading message
      useChatStore.setState({ loadingMessage: 'Loading...' });

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      const state = useChatStore.getState();
      expect(state.loadingMessage).toBeNull();
      expect(state.error).toBeTruthy();
    });

    it('handles malformed action metadata gracefully', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          // Invalid JSON
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{invalid}<<<METADATA_END>>>',
            ),
          );
          controller.enqueue(
            new TextEncoder().encode('Content after bad metadata'),
          );
          controller.close();
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      // Should not error, just skip the bad metadata
      const state = useChatStore.getState();
      expect(state.error).toBeNull();
    });
  });

  describe('Content Cleaning', () => {
    it('removes metadata markers from final content', async () => {
      const conversation: Conversation = {
        id: 'test',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '\n\n<<<METADATA_START>>>{"action":"Processing"}<<<METADATA_END>>>',
            ),
          );
          controller.enqueue(
            new TextEncoder().encode('Clean content without metadata'),
          );
          controller.close();
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);

      await useChatStore.getState().sendMessage(
        {
          role: 'user',
          content: 'Test',
          messageType: MessageType.TEXT,
        },
        conversation,
      );

      // Content should not contain metadata markers
      const state = useChatStore.getState();
      expect(state.streamingContent).not.toContain('<<<METADATA_START>>>');
      expect(state.streamingContent).not.toContain('<<<METADATA_END>>>');
    });
  });
});
