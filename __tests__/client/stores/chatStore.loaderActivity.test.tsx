import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { emitAgentActivity } from '@/lib/streamMarkers';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/**
 * A pre-model stage (web search) reports what it is doing BEFORE any text
 * streams. The loader must switch from "Thinking…" to that activity while
 * the stage runs, and only clear once the model actually writes.
 */
describe('ChatStore - loader shows pre-model activity', () => {
  const initialState = useChatStore.getState();
  beforeEach(() => {
    useChatStore.setState(initialState, true);
  });

  it('switches to the search activity before text arrives and clears on text', async () => {
    const encoder = new TextEncoder();
    const seen: Array<string | null> = [];
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.loadingMessage !== previous.loadingMessage) {
        seen.push(state.loadingMessage);
      }
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    useChatStore.setState({
      isStreaming: true,
      loadingMessage: 'chat.thinking',
    });
    const done = useChatStore
      .getState()
      .processStream(stream, new StreamParser(), null);
    controller.enqueue(
      encoder.encode(
        emitAgentActivity('chat.activity.searchingWebFor', { query: 'India' }),
      ),
    );
    // Let the marker chunk be read and applied.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useChatStore.getState().loadingMessage).toBe(
      'chat.activity.searchingWebFor',
    );
    expect(useChatStore.getState().loadingMessageParams).toEqual({
      query: 'India',
    });
    controller.enqueue(encoder.encode('India is holding elections. '));
    controller.close();
    await done;
    unsubscribe();
    // Initial "Thinking…" → the stage's activity → cleared when text lands.
    expect(seen).toEqual([
      'chat.thinking',
      'chat.activity.searchingWebFor',
      null,
    ]);
  });
});

describe('ChatStore - full send flow shows the search activity', () => {
  const initialState = useChatStore.getState();
  const conversation = {
    id: 'conv-1',
    name: '',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'What is happening in India',
        messageType: MessageType.TEXT,
      },
    ],
    model: {
      id: 'gpt-5.2-chat',
      name: 'GPT-5.2 Chat',
      maxLength: 4000,
      tokenLimit: 4000,
    },
    prompt: '',
    temperature: 0.7,
    folderId: null,
  } as unknown as Conversation;

  beforeEach(() => {
    useChatStore.setState(initialState, true);
    useConversationStore.setState({
      conversations: [conversation],
      selectedConversationId: 'conv-1',
      folders: [],
      isLoaded: true,
    });
    vi.restoreAllMocks();
  });

  it('labels the wait with the search query before any text streams', async () => {
    const encoder = new TextEncoder();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    vi.spyOn(chatService, 'chat').mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await wait(100);
            controller.enqueue(
              encoder.encode(
                emitAgentActivity('chat.activity.searchingWebFor', {
                  query: 'India',
                }),
              ),
            );
            await wait(500);
            controller.enqueue(encoder.encode('India is holding elections.'));
            controller.close();
          },
        }),
    );
    const seen: Array<string | null> = [];
    const unsubscribe = useChatStore.subscribe((s, p) => {
      if (s.loadingMessage !== p.loadingMessage) seen.push(s.loadingMessage);
    });
    const done = useChatStore
      .getState()
      .sendMessage(
        {
          role: 'user',
          content: 'What is happening in India',
          messageType: MessageType.TEXT,
        },
        conversation,
      );
    await wait(400);
    const mid = {
      label: useChatStore.getState().loadingMessage,
      params: useChatStore.getState().loadingMessageParams,
      seen: [...seen],
    };
    await done;
    unsubscribe();
    expect(mid).toEqual({ probe: true });
  }, 10000);
});
