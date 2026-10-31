import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { useChatStore } from '@/client/stores/chatStore';
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
