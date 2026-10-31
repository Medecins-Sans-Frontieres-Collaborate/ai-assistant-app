import { Message, MessageType } from '@/types/chat';

import { QueuedSend, useChatStore } from '@/client/stores/chatStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/**
 * Messages typed while a response streams are held in the store (FIFO,
 * per conversation) and drained by useChatActions once the stream settles.
 */

const message = (id: string): Message => ({
  id,
  role: 'user',
  content: `text ${id}`,
  messageType: MessageType.TEXT,
});

const entry = (id: string, conversationId = 'c1'): QueuedSend => ({
  message: message(id),
  conversationId,
});

describe('chatStore queued sends', () => {
  beforeEach(() => {
    useChatStore.setState({ queuedSends: [] });
  });

  it('queues in order and shifts per conversation', () => {
    const store = useChatStore.getState();
    store.queueSend(entry('a'));
    store.queueSend(entry('b', 'c2'));
    store.queueSend(entry('c'));
    expect(useChatStore.getState().queuedSends).toHaveLength(3);

    expect(store.shiftQueuedSend('c1')?.message.id).toBe('a');
    expect(store.shiftQueuedSend('c1')?.message.id).toBe('c');
    expect(store.shiftQueuedSend('c1')).toBeNull();
    expect(
      useChatStore.getState().queuedSends.map((e) => e.message.id),
    ).toEqual(['b']);
  });

  it('removes one entry by reference and ignores unknown entries', () => {
    const store = useChatStore.getState();
    const first = entry('a');
    store.queueSend(first);
    store.queueSend(entry('b'));
    expect(store.removeQueuedSend(first)).toBe(first);
    expect(store.removeQueuedSend(first)).toBeNull();
    expect(
      useChatStore.getState().queuedSends.map((e) => e.message.id),
    ).toEqual(['b']);
  });

  it('survives clearStreamingState (the queue outlives the stream)', () => {
    const store = useChatStore.getState();
    store.queueSend(entry('a'));
    store.clearStreamingState();
    expect(useChatStore.getState().queuedSends).toHaveLength(1);
  });
});
