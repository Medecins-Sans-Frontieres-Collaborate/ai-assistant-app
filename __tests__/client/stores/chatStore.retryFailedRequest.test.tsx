import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function makeFailedConversation(): Conversation {
  return {
    id: 'conv-failed',
    name: '',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: 'tell me about NetSuite invoices',
        messageType: MessageType.TEXT,
      },
    ],
    model: {
      id: 'foundry-test-agent',
      name: 'Test Agent',
      maxLength: 4000,
      tokenLimit: 4000,
      isOrganizationAgent: true,
    } as any,
    prompt: '',
    temperature: 0.7,
    folderId: null,
  };
}

describe('chatStore.retryFailedRequest', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentMessage: undefined,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      citations: [],
      error: 'Error encountered while enumerating tools from remote server',
      stopRequested: false,
      loadingMessage: null,
      abortController: null,
      isRetrying: false,
      failedConversation: makeFailedConversation(),
      failedSearchMode: undefined,
      errorIsRecoverable: true,
    });
    useConversationStore.setState({
      conversations: [makeFailedConversation()],
      selectedConversationId: 'conv-failed',
      folders: [],
      isLoaded: true,
    });
    vi.restoreAllMocks();
  });

  it('does nothing when there is no failed conversation', async () => {
    useChatStore.setState({ failedConversation: null });
    const spy = vi.spyOn(chatService, 'chat');

    await useChatStore.getState().retryFailedRequest();

    expect(spy).not.toHaveBeenCalled();
  });

  it('clears error state before retrying', async () => {
    vi.spyOn(chatService, 'chat').mockResolvedValue(streamFromChunks(['hi']));

    const promise = useChatStore.getState().retryFailedRequest();
    // Error is cleared synchronously before the network call.
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().failedConversation).toBeNull();
    await promise;
  });

  it('re-sends the trailing user message through sendMessage', async () => {
    const spy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(streamFromChunks(['retry succeeded']));

    await useChatStore.getState().retryFailedRequest();

    expect(spy).toHaveBeenCalledOnce();
    // The mocked chatService receives the user's original prompt back.
    const [, messages] = spy.mock.calls[0];
    const lastSent = (messages as { content?: string }[])[
      (messages as unknown[]).length - 1
    ];
    expect(lastSent?.content).toBe('tell me about NetSuite invoices');
  });

  it('re-populates error state when the retry itself fails', async () => {
    vi.spyOn(chatService, 'chat').mockRejectedValue(new Error('still broken'));

    await useChatStore.getState().retryFailedRequest();

    expect(useChatStore.getState().error).toBe('still broken');
  });
});
